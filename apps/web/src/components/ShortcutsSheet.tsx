/**
 * @file ShortcutsSheet.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 快捷键速查表：玻璃浮层卡片列出全部键位（N/／/？/Esc/⌘Enter/←→），? 或侧栏按钮唤起，Esc 或点遮罩关闭。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { createPortal } from "react-dom";
import { Keyboard, X } from "lucide-react";

/** 速查表条目。 */
const SHEET_ROWS: Array<{ keys: string[]; desc: string }> = [
  { keys: ["N"], desc: "新建项目（回到创建视图）" },
  { keys: ["/"], desc: "聚焦项目搜索框" },
  { keys: ["?"], desc: "显示 / 隐藏本速查表" },
  { keys: ["Esc"], desc: "关闭速查表 / 灯箱 / 确认框 / 日志全屏" },
  { keys: ["⌘ 或 Ctrl", "Enter"], desc: "创建页生成任务（在描述框内）" },
  { keys: ["←", "→"], desc: "灯箱内切换镜头画面" }
];

/** ShortcutsSheet 组件入参。 */
interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染快捷键速查浮层。
 */
export default function ShortcutsSheet({ open, onClose }: Props) {
  if (!open) {
    return null;
  }
  return createPortal(
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="sheet-card" role="dialog" aria-label="快捷键速查" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <Keyboard size={16} aria-hidden="true" />
          <b>键盘快捷键</b>
          <span className="spacer" />
          <button className="icon-btn" aria-label="关闭速查表" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <table className="sheet-table">
          <tbody>
            {SHEET_ROWS.map((row) => (
              <tr key={row.desc}>
                <td>
                  {row.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </td>
                <td>{row.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
    document.body
  );
}
