/**
 * @file main.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description apps/web 入口：引入全局样式，以 ToastProvider 包裹根组件后挂载 React 应用。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./hooks/useToasts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>
);
