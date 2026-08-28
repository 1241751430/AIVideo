import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AppConfig, loadConfig } from "@aivideo/core";
import { createProviderSelection, testProviders } from "./index.js";

test("createProviderSelection returns default local providers", () => {
  const config = loadConfig(process.cwd());
  const providers = createProviderSelection(config, "default");
  assert.equal(providers.text?.id, "local-rule-text");
  assert.equal(providers.image?.id, "noop-image");
});

test("testProviders reports health for configured profile", async () => {
  const config = loadConfig(process.cwd());
  const health = await testProviders(config, "default");
  assert.equal(health.length, 4);
  assert.ok(health.some((item) => item.providerId === "local-rule-text"));
});

test("custom baseURL is rejected unless explicitly allowed", async () => {
  const config = loadConfig(process.cwd());
  const original = config.providers["openai-text"];
  assert.ok(original);
  config.providers["openai-text"] = {
    ...original,
    baseURL: "https://evil.example.com/v1"
  };

  await assert.rejects(
    async () => {
      await testProviders(config, "openai");
    },
    /trusted host list/
  );
});

// --- ArkTTS speech provider (mocked fetch; no real network calls) ---

function speechTestConfig(): AppConfig {
  const config = loadConfig(process.cwd());
  // A synthetic profile that selects the remote speech provider without
  // touching the shipped profiles (they stay on local-say).
  config.profiles["tts-test"] = { speech: "volcengine-speech" };
  return config;
}

function installFetchStub(handler: () => Response): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler();
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/**
 * Sequential fetch stub: each call consumes the next canned Response (recording
 * the request for assertions). Throws loudly if the provider calls more times
 * than the script covers, so stale/extra requests fail the test instead of
 * hanging.
 */
function installScriptedFetch(script: Response[]): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const remaining = [...script];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = remaining.shift();
    if (!next) {
      throw new Error(`fetch script exhausted after ${calls.length - 1} calls (extra call: ${String(input)})`);
    }
    return next;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}

test("ark-tts-speech health check fails without credentials", async () => {
  const config = speechTestConfig();
  await withEnv({ ARK_TTS_APP_ID: undefined, ARK_TTS_ACCESS_KEY: undefined }, async () => {
    const health = await testProviders(config, "tts-test");
    const speech = health.find((item) => item.capability === "speech");
    assert.ok(speech);
    assert.equal(speech.ok, false);
    assert.match(speech.message, /Missing speech credential env/);
  });
});

test("ark-tts-speech health check passes once credentials are configured", async () => {
  const config = speechTestConfig();
  await withEnv({ ARK_TTS_APP_ID: "app-1", ARK_TTS_ACCESS_KEY: "token-1" }, async () => {
    const health = await testProviders(config, "tts-test");
    const speech = health.find((item) => item.capability === "speech");
    assert.ok(speech);
    assert.equal(speech.ok, true);
    assert.equal(speech.liveChecked, false); // never fires a billed request in health checks
  });
});

test("ark-tts-speech writes decoded audio from a success payload", async () => {
  const config = speechTestConfig();
  const provider = createProviderSelection(config, "tts-test").speech;
  assert.ok(provider);
  const audioBase64 = Buffer.from("fake-wav-bytes").toString("base64");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ code: 3004, message: "success", audio: audioBase64 }), { status: 200 });
  }) as typeof fetch;
  try {
    await withEnv(
      { ARK_TTS_APP_ID: "app-1", ARK_TTS_ACCESS_KEY: "token-1", ARK_TTS_VOICE: "zh_female_qingxin" },
      async () => {
        const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-tts-")), "shot-1.wav");
        await provider.synthesizeSpeech({ text: "你好，世界", outputPath });
        assert.deepEqual(readFileSync(outputPath), Buffer.from("fake-wav-bytes"));

        assert.equal(calls.length, 1);
        const call = calls[0]!;
        assert.equal(call.url, "https://openspeech.bytedance.com/api/v1/tts");
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer; token-1"); // literal semicolon per vendor spec
        assert.equal(headers["X-Api-App-Key"], "app-1");
        const body = JSON.parse(String(call.init.body));
        assert.equal(body.app.appid, "app-1");
        assert.equal(body.audio.voice_type, "zh_female_qingxin");
        assert.equal(body.text, "你好，世界");
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("ark-tts-speech rejects error codes and empty payloads", async () => {
  const config = speechTestConfig();
  const provider = createProviderSelection(config, "tts-test").speech;
  assert.ok(provider);
  const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-tts-")), "narration.wav");

  await withEnv({ ARK_TTS_APP_ID: "app-1", ARK_TTS_ACCESS_KEY: "token-1" }, async () => {
    // Non-success code must surface as a rejection, never silent narration.
    let stub = installFetchStub(() =>
      new Response(JSON.stringify({ code: 3005, message: "quota exceeded" }), { status: 200 })
    );
    try {
      await assert.rejects(() => provider.synthesizeSpeech({ text: "x", outputPath }), /code 3005/);
    } finally {
      stub.restore();
    }

    // Success envelope with no audio data.
    stub = installFetchStub(() => new Response(JSON.stringify({ code: 3004 }), { status: 200 }));
    try {
      await assert.rejects(() => provider.synthesizeSpeech({ text: "x", outputPath }), /no audio payload/);
    } finally {
      stub.restore();
    }

    // HTTP transport failure includes the status code.
    stub = installFetchStub(() => new Response("gateway boom", { status: 502 }));
    try {
      await assert.rejects(() => provider.synthesizeSpeech({ text: "x", outputPath }), /HTTP 502/);
    } finally {
      stub.restore();
    }
  });
});

test("ark-tts-speech degrades to the local engine when credentials are missing", async () => {
  const hasLocalEngine =
    spawnSync("say", ["-v", "?"]).status === 0 || spawnSync("espeak-ng", ["--version"]).status === 0;
  if (!hasLocalEngine) {
    return; // fallback needs a local engine; nothing to verify without one
  }
  const config = speechTestConfig();
  const provider = createProviderSelection(config, "tts-test").speech;
  assert.ok(provider);
  const stub = installFetchStub(() => new Response("{}", { status: 200 }));
  try {
    await withEnv({ ARK_TTS_APP_ID: undefined, ARK_TTS_ACCESS_KEY: undefined }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-tts-")), "fallback.wav");
      await provider.synthesizeSpeech({ text: "回退测试", outputPath });
      assert.equal(stub.calls.length, 0); // remote endpoint must not be reached without credentials
      assert.ok(readFileSync(outputPath).length > 0);
    });
  } finally {
    stub.restore();
  }
});

// --- Ark Seedance video provider (mocked fetch; no billed calls) ---

const ARK_TASK_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";

function arkVideoTestConfig(): AppConfig {
  const config = loadConfig(process.cwd());
  config.profiles["video-test"] = { video: "video-test-provider" };
  config.providers["video-test-provider"] = {
    type: "ark-seedance-video",
    capability: "video",
    enabled: true,
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_VIDEO_TEST_KEY",
    model: "doubao-seedance-test"
  };
  return config;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

/**
 * Canned create→poll→download script for a successful generation, optionally
 * with non-terminal poll states before the success. Keep the non-terminal
 * list short: each one costs a real 5s sleep in pollTask.
 */
function arkHappyScript(videoUrl: string, pollStatuses: string[] = ["queued"]): Response[] {
  const polls = pollStatuses.map((status) => jsonResponse({ status }));
  const success = jsonResponse({ status: "succeeded", content: { video_url: videoUrl } });
  return [
    jsonResponse({ id: "task-123" }),
    ...polls,
    success,
    new Response(Buffer.from("fake-video-bytes"), { status: 200 })
  ];
}

function videoRequest(
  outputPath: string,
  overrides: Partial<{
    prompt: string;
    durationSeconds: number;
    aspectRatio: string;
    referenceImagePaths: string[];
  }> = {}
) {
  return {
    prompt: overrides.prompt ?? "一只赛博熊猫跳华尔兹",
    durationSeconds: overrides.durationSeconds ?? 6,
    aspectRatio: overrides.aspectRatio,
    outputPath,
    ...(overrides.referenceImagePaths ? { referenceImagePaths: overrides.referenceImagePaths } : {})
  };
}

test("ark-seedance-video happy path: creates task, polls, downloads, writes file", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  // One non-terminal poll: each extra one would cost a real 5s sleep.
  const stub = installScriptedFetch(arkHappyScript("https://ark-example.volces.com/out.mp4", ["queued"]));
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-1.mp4");
      const result = await provider.generateVideo(videoRequest(outputPath));
      assert.equal(result.outputPath, outputPath);
      assert.deepEqual(readFileSync(outputPath), Buffer.from("fake-video-bytes"));

      // create → queued → succeeded → download
      assert.equal(stub.calls.length, 4);
      const create = stub.calls[0]!;
      assert.equal(create.url, ARK_TASK_URL);
      assert.equal((create.init.headers as Record<string, string>).Authorization, "Bearer test-key");
      const createBody = JSON.parse(String(create.init.body));
      assert.equal(createBody.model, "doubao-seedance-test");
      assert.deepEqual(createBody.content, [{ type: "text", text: "一只赛博熊猫跳华尔兹" }]);
      assert.equal(createBody.duration, 6);

      const poll = stub.calls[1]!;
      assert.equal(poll.url, `${ARK_TASK_URL}/task-123`);
      const download = stub.calls[3]!;
      assert.equal(download.url, "https://ark-example.volces.com/out.mp4");
    });
  } finally {
    stub.restore();
  }
});

test("ark-seedance-video clamps duration to the model range and passes ratio", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const stub = installScriptedFetch(arkHappyScript("https://ark-example.volces.com/out.mp4", []));
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-clamp.mp4");
      await provider.generateVideo(
        videoRequest(outputPath, { durationSeconds: 100, aspectRatio: "9:16" })
      );
      const createBody = JSON.parse(String(stub.calls[0]!.init.body));
      assert.equal(createBody.duration, 12); // upper clamp of 2..12
      assert.equal(createBody.ratio, "9:16");
    });
  } finally {
    stub.restore();
  }
});

// Minimal 1x1 transparent PNG, used as a realistic reference-image payload.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function writeTempPng(name = "reference.png"): string {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-ref-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));
  return filePath;
}

test("ark-seedance-video sends a first_frame image when referenceImagePaths is given", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const reference = writeTempPng();
  const stub = installScriptedFetch(arkHappyScript("https://ark-example.volces.com/out.mp4", []));
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-i2v.mp4");
      await provider.generateVideo(videoRequest(outputPath, { referenceImagePaths: [reference] }));
      const createBody = JSON.parse(String(stub.calls[0]!.init.body));
      // Image frame comes first; the text prompt follows.
      assert.deepEqual(Object.keys(createBody.content[0]), ["type", "image_url", "role"]);
      assert.equal(createBody.content[0].type, "image_url");
      assert.equal(createBody.content[0].role, "first_frame");
      assert.equal(
        createBody.content[0].image_url.url,
        `data:image/png;base64,${TINY_PNG_BASE64}`
      );
      assert.deepEqual(createBody.content[1], { type: "text", text: "一只赛博熊猫跳华尔兹" });
    });
  } finally {
    stub.restore();
  }
});

test("imageToDataURI guards reject bad references before any network call", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const dir = mkdtempSync(join(tmpdir(), "aivideo-ref-guard-"));
  const emptyPng = join(dir, "empty.png");
  writeFileSync(emptyPng, "");
  const notAnImage = join(dir, "notes.txt");
  writeFileSync(notAnImage, "hello");
  const hugePng = join(dir, "huge.png");
  writeFileSync(hugePng, Buffer.alloc(10 * 1024 * 1024 + 1));

  const guardCases: Array<{ name: string; path: string; expected: RegExp }> = [
    { name: "missing file", path: join(dir, "does-not-exist.png"), expected: /Reference image not found/ },
    { name: "empty file", path: emptyPng, expected: /Reference image is empty/ },
    { name: "unsupported format", path: notAnImage, expected: /Unsupported reference image format/ },
    { name: "oversized file", path: hugePng, expected: /exceeds 10485760 bytes/ }
  ];
  for (const guardCase of guardCases) {
    // Scripted fetch with an empty script: any request throws loudly, proving
    // the validation fails before (and without) any billed call.
    const stub = installScriptedFetch([]);
    try {
      await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
        const outputPath = join(dir, "shot-guard.mp4");
        await assert.rejects(
          () => provider.generateVideo(videoRequest(outputPath, { referenceImagePaths: [guardCase.path] })),
          guardCase.expected,
          guardCase.name
        );
        assert.equal(stub.calls.length, 0, guardCase.name);
      });
    } finally {
      stub.restore();
    }
  }
});

test("ark-seedance-video never retries a billed create+poll cycle", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  // create-task fails once: withRetry(1) means exactly one attempt, no re-billing.
  const stub = installScriptedFetch([new Response("rate limited", { status: 429 })]);
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-nb.mp4");
      await assert.rejects(
        () => provider.generateVideo(videoRequest(outputPath)),
        /video task creation failed with HTTP 429: rate limited/
      );
      assert.equal(stub.calls.length, 1);
    });
  } finally {
    stub.restore();
  }
});

test("ark-seedance-video surfaces terminal task failure with the vendor reason", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const stub = installScriptedFetch([
    jsonResponse({ id: "task-fail" }),
    jsonResponse({ status: "failed", error: { code: "InternalServiceError", message: "content policy blocked" } })
  ]);
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-fail.mp4");
      await assert.rejects(
        () => provider.generateVideo(videoRequest(outputPath)),
        /video task failed: content policy blocked/
      );
      assert.equal(stub.calls.length, 2); // terminal state exits the poll loop immediately
    });
  } finally {
    stub.restore();
  }
});

test("ark-seedance-video rejects a succeeded task with no video URL", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const stub = installScriptedFetch([jsonResponse({ id: "task-nourl" }), jsonResponse({ status: "succeeded" })]);
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-nourl.mp4");
      await assert.rejects(
        () => provider.generateVideo(videoRequest(outputPath)),
        /succeeded but returned no video URL/
      );
    });
  } finally {
    stub.restore();
  }
});

test("ark-seedance-video poll HTTP failure includes status and detail", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const stub = installScriptedFetch([
    jsonResponse({ id: "task-poll" }),
    new Response("task store unavailable", { status: 503 })
  ]);
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-poll.mp4");
      await assert.rejects(
        () => provider.generateVideo(videoRequest(outputPath)),
        /video task poll failed with HTTP 503: task store unavailable/
      );
    });
  } finally {
    stub.restore();
  }
});

test("ark-seedance-video create-task rejection without a task id", async () => {
  const config = arkVideoTestConfig();
  const provider = createProviderSelection(config, "video-test").video;
  assert.ok(provider);
  const stub = installScriptedFetch([jsonResponse({})]);
  try {
    await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-noid.mp4");
      await assert.rejects(
        () => provider.generateVideo(videoRequest(outputPath)),
        /video task creation returned no task id/
      );
    });
  } finally {
    stub.restore();
  }
});

test("ark-seedance-video download guards: untrusted host, http scheme, oversize, empty body", async () => {
  const guardCases: Array<{ name: string; url: string; download: Response; expected: RegExp }> = [
    {
      name: "untrusted host",
      url: "https://evil.example.com/x.mp4",
      download: new Response("payload", { status: 200 }),
      expected: /host evil\.example\.com is not trusted/
    },
    {
      name: "http scheme",
      url: "http://ark-example.volces.com/x.mp4",
      download: new Response("payload", { status: 200 }),
      expected: /must use HTTPS/
    },
    {
      name: "content-length over cap",
      url: "https://ark-example.volces.com/big.mp4",
      // Small body but forged content-length header past the 200MB cap —
      // the pre-read check must reject before buffering anything.
      download: new Response("small", { status: 200, headers: { "content-length": "209715201" } }),
      expected: /exceeds 209715200 bytes/
    },
    {
      name: "empty body",
      url: "https://ark-example.volces.com/nothing.mp4",
      download: new Response("", { status: 200 }),
      expected: /returned an empty body/
    },
    {
      name: "download HTTP failure",
      url: "https://ark-example.volces.com/gone.mp4",
      download: new Response("gone", { status: 404 }),
      expected: /Video download failed with HTTP 404/
    }
  ];

  for (const guardCase of guardCases) {
    const config = arkVideoTestConfig();
    const provider = createProviderSelection(config, "video-test").video;
    assert.ok(provider, guardCase.name);
    const stub = installScriptedFetch([
      jsonResponse({ id: "task-dl" }),
      jsonResponse({ status: "success", content: { url: guardCase.url } }), // content.url alias must also work
      guardCase.download
    ]);
    try {
      await withEnv({ ARK_VIDEO_TEST_KEY: "test-key" }, async () => {
        const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-video-")), "shot-guard.mp4");
        await assert.rejects(() => provider.generateVideo(videoRequest(outputPath)), guardCase.expected);
      });
    } finally {
      stub.restore();
    }
  }
});

test("ark-seedance-video health check fails without an API key", async () => {
  const config = arkVideoTestConfig();
  await withEnv({ ARK_VIDEO_TEST_KEY: undefined }, async () => {
    const providers = createProviderSelection(config, "video-test");
    assert.ok(providers.video);
    const health = await providers.video.test();
    assert.equal(health.ok, false);
    assert.match(health.message, /Missing API key env: ARK_VIDEO_TEST_KEY/);
    assert.equal(health.liveChecked, false);
  });
});

// --- OpenAI-compatible image provider (mocked fetch) ---

function imageTestConfig(): AppConfig {
  const config = loadConfig(process.cwd());
  config.profiles["image-test"] = { image: "image-test-provider" };
  config.providers["image-test-provider"] = {
    type: "openai-compatible-image",
    capability: "image",
    enabled: true,
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_IMAGE_TEST_KEY",
    model: "seedream-test",
    sizeMap: { "9:16": "2K", default: "1K" },
    extraBody: { watermark: false }
  };
  return config;
}

test("openai-compatible-image decodes b64_json and merges size/extraBody", async () => {
  const config = imageTestConfig();
  const provider = createProviderSelection(config, "image-test").image;
  assert.ok(provider);
  const b64 = Buffer.from("png-bytes").toString("base64");
  const stub = installScriptedFetch([jsonResponse({ data: [{ b64_json: b64 }] })]);
  try {
    await withEnv({ ARK_IMAGE_TEST_KEY: "img-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-image-")), "shot-1.png");
      await provider.generateImage({ prompt: "海报", outputPath, aspectRatio: "9:16" });
      assert.deepEqual(readFileSync(outputPath), Buffer.from("png-bytes"));

      const call = stub.calls[0]!;
      assert.equal(call.url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
      assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer img-key");
      const body = JSON.parse(String(call.init.body));
      assert.equal(body.model, "seedream-test");
      assert.equal(body.size, "2K"); // sizeMap["9:16"]
      assert.equal(body.watermark, false); // extraBody merged
    });
  } finally {
    stub.restore();
  }
});

test("openai-compatible-image falls back to the default size", async () => {
  const config = imageTestConfig();
  const provider = createProviderSelection(config, "image-test").image;
  assert.ok(provider);
  const b64 = Buffer.from("x").toString("base64");
  const stub = installScriptedFetch([jsonResponse({ data: [{ b64_json: b64 }] })]);
  try {
    await withEnv({ ARK_IMAGE_TEST_KEY: "img-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-image-")), "shot-default.png");
      await provider.generateImage({ prompt: "p", outputPath, aspectRatio: "1:2" }); // unmapped ratio
      const body = JSON.parse(String(stub.calls[0]!.init.body));
      assert.equal(body.size, "1K"); // sizeMap.default
    });
  } finally {
    stub.restore();
  }
});

test("openai-compatible-image downloads a trusted url payload", async () => {
  const config = imageTestConfig();
  const provider = createProviderSelection(config, "image-test").image;
  assert.ok(provider);
  const stub = installScriptedFetch([
    jsonResponse({ data: [{ url: "https://ark-offload.volces.com/img.png" }] }),
    new Response(Buffer.from("downloaded-png"), { status: 200 })
  ]);
  try {
    await withEnv({ ARK_IMAGE_TEST_KEY: "img-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-image-")), "shot-url.png");
      await provider.generateImage({ prompt: "p", outputPath });
      assert.deepEqual(readFileSync(outputPath), Buffer.from("downloaded-png"));
      assert.equal(stub.calls.length, 2);
    });
  } finally {
    stub.restore();
  }
});

test("openai-compatible-image rejects malformed payloads", async () => {
  // billedAttempts = how many generation calls the rejection must consume.
  // Payload-shape and download-guard failures are deterministic: they resolve
  // outside the retry budget and must NOT re-bill (1 attempt). Only a
  // transient HTTP failure of the generation call retries (3 attempts).
  // Responses are single-use in Node, so each attempt gets a fresh factory.
  const rejections: Array<{ name: string; make: () => Response; billedAttempts: number; expected: RegExp }> = [
    {
      name: "http error",
      make: () => new Response("bad gateway", { status: 500 }),
      billedAttempts: 3,
      expected: /failed with HTTP 500: bad gateway/
    },
    {
      name: "empty data",
      make: () => jsonResponse({ data: [] }),
      billedAttempts: 1,
      expected: /returned an empty image response/
    },
    {
      // truthy string that base64-decodes to zero bytes
      name: "empty base64",
      make: () => jsonResponse({ data: [{ b64_json: "====" }] }),
      billedAttempts: 1,
      expected: /empty base64 image payload/
    },
    {
      name: "no url or b64",
      make: () => jsonResponse({ data: [{ revised_prompt: "hmm" }] }),
      billedAttempts: 1,
      expected: /neither an image URL nor a base64 payload/
    },
    {
      name: "untrusted url host",
      make: () => jsonResponse({ data: [{ url: "https://evil.example.com/a.png" }] }),
      billedAttempts: 1,
      expected: /host evil\.example\.com is not trusted/
    }
  ];
  for (const rejection of rejections) {
    const config = imageTestConfig();
    const provider = createProviderSelection(config, "image-test").image;
    assert.ok(provider, rejection.name);
    // Download guards throw before any fetch, so only the billed calls are scripted.
    const stub = installScriptedFetch(Array.from({ length: rejection.billedAttempts }, rejection.make));
    try {
      await withEnv({ ARK_IMAGE_TEST_KEY: "img-key" }, async () => {
        const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-image-")), "shot-bad.png");
        await assert.rejects(() => provider.generateImage({ prompt: "p", outputPath }), rejection.expected);
        const billed = stub.calls.filter((call) => call.url.endsWith("/images/generations"));
        assert.equal(billed.length, rejection.billedAttempts, rejection.name);
      });
    } finally {
      stub.restore();
    }
  }
});

test("openai-compatible-image retries transient failures once and succeeds", async () => {
  const config = imageTestConfig();
  const provider = createProviderSelection(config, "image-test").image;
  assert.ok(provider);
  const b64 = Buffer.from("second-try").toString("base64");
  // First attempt: HTTP 500 (retryable). Second attempt: success.
  const stub = installScriptedFetch([
    new Response("flaky", { status: 500 }),
    jsonResponse({ data: [{ b64_json: b64 }] })
  ]);
  try {
    await withEnv({ ARK_IMAGE_TEST_KEY: "img-key" }, async () => {
      const outputPath = join(mkdtempSync(join(tmpdir(), "aivideo-image-")), "shot-retry.png");
      const started = Date.now();
      await provider.generateImage({ prompt: "p", outputPath });
      assert.deepEqual(readFileSync(outputPath), Buffer.from("second-try"));
      assert.equal(stub.calls.length, 2);
      assert.ok(Date.now() - started >= 900); // 1s backoff between attempts
    });
  } finally {
    stub.restore();
  }
});
