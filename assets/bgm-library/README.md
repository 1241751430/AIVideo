# 本地 BGM 曲库

流水线在**没有用户上传背景音乐**时，会拿脚本里的 `bgmStyle` 到这里找一曲。找到就配，找不到就明说「本片无 BGM」，不会凭空生成一首。

## 放置规则

把音频文件直接放在本目录（不要建子目录），扩展名必须是 `render.py` 认识的五种之一：

```
mp3 / wav / aac / m4a / ogg
```

文件名即标签，`local-library-music` 按下面的顺序挑最贴近 `bgmStyle` 的一首：

1. 文件名与 `bgmStyle` **完全相同**（忽略大小写、空格与标点）：`epic-trailer.mp3` 对应 `bgmStyle: epic trailer`
2. 文件名**整体出现在** `bgmStyle` 里：`ambient.mp3` 对应 `bgmStyle: warm ambient piano`
3. 文件名按分隔符（`-`、`_`、空格等）切出的任一段（≥2 字符）出现在 `bgmStyle` 里

同分时按文件名排序取第一个——同一风格每次都挑到同一首，可复现。

例：

```
assets/bgm-library/
├─ epic-trailer.mp3
├─ warm-ambient.wav
└─ corporate-uplift.m4a
```

## 指向别处

不想把曲子放进仓库目录，可以在 `aivideo.config.yaml` 里给 `local-library-music` 一个 `baseURL`：

```yaml
providers:
  local-library-music:
    type: local-library-music
    capability: music
    enabled: true
    baseURL: /Volumes/Media/bgm
```

缺省是 `<工作目录>/assets/bgm-library`。

## 版权

**本目录里的音频不进版本库**（`.gitignore` 只放行本 README）。放进来的每一首都要自己确有权使用——商用片子的 BGM 授权由使用者负责，本项目不代为判断。上传来源受版权限制的音乐，风险由上传者承担。

## 换了曲子之后

BGM 文件已纳入渲染指纹：换曲、删曲、改曲都会让成片失效，界面提示「需重新渲染」。渲染 worker 用 `-stream_loop -1` 循环播放，因此曲子短于成片也没问题（音频阶段会在日志里提一句）。