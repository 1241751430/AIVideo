/**
 * @file main.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description apps/web 入口：挂载 React 根组件并引入全局样式。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
