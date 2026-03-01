import { ViewPlugin, Decoration, gutter, GutterMarker } from "https://esm.sh/@codemirror/view";
import { isBlockSeparatorLine } from "./markdown-look.js";
import { getCurrentTitle } from "../firebase-sync.js";

// ====== ブロック関連関数 ======

export function isBlockStartSafe(state, lineDesc) {
    if (!lineDesc || lineDesc.from == null) return false;
    const line = state.doc.lineAt(lineDesc.from);

    if (isBlockSeparatorLine(line.text)) return false;
    if (line.number === 1) return true;

    const prev = state.doc.line(line.number - 1);
    return isBlockSeparatorLine(prev.text);
}

export function getBlockText(state, startLineNumber) {
    const doc = state.doc;
    const lines = [];

    let lineNo = startLineNumber;
    const maxLine = doc.lines;

    while (lineNo <= maxLine) {
        const line = doc.line(lineNo);
        const text = line.text;

        if (isBlockSeparatorLine(text)) break;
        if (lineNo !== startLineNumber && isBlockStartSafe(state, { from: line.from })) break;

        lines.push(text);
        lineNo++;
    }

    return lines;
}

// ====== ブロックエクスポート / アクション ======

export function blockUrlBuilders(blockLines, action) {
    const title = getCurrentTitle();
    if (action === "scrapbox") {
        const date = encodeURIComponent(`${title}日誌`);
        const bodyText = blockLines.join("\n").replace(/  /g, " ").replace(/\- /g, " ");
        const body = encodeURIComponent(bodyText);
        return `sbporter://scrapbox.io/choiyaki/${date}?body=${body}`;
    } else if (action === "choidiary") {
        const bodyText = blockLines.join("\n").replace(/  /g, " ").replace(/\- /g, " ");
        const body = encodeURIComponent(bodyText);
        return `touch-https://scrapbox.io/choidiary/${title}?body=${body}`;
    } else if (action === "SaveLog") {
        const bodyText = blockLines.join("\n").replace(/  /g, " ").replace(/\- /g, " ");
        const body = encodeURIComponent(bodyText);
        return `shortcuts://run-shortcut?name=AddObsidian&input=${body}`;
    }
    // フェーズ2の "copy" は後ほど実装
}

export function insertMemoMark(view, lineNumber, action) {
    if (!view || typeof lineNumber !== "number") return;

    const doc = view.state.doc;
    if (lineNumber < 1 || lineNumber > doc.lines) return;

    const line = doc.line(lineNumber);
    if (line.text.startsWith("📝") || line.text.startsWith("📓") || line.text.startsWith("💾")) return;

    let mark = "💾";
    if (action === "scrapbox") mark = "📝";
    else if (action === "choidiary") mark = "📓";

    view.dispatch({
        changes: {
            from: line.from,
            insert: mark
        }
    });
}

export function showBlockMenu({ view, lineNumber, anchorEl }) {
    document.querySelectorAll(".cm-block-menu").forEach(el => el.remove());

    const menu = document.createElement("div");
    menu.className = "cm-block-menu";

    menu.innerHTML = `
    <button data-action="scrapbox">📝Choiyaki</button>
    <button data-action="choidiary">📓日記帳</button>
    <button data-action="SaveLog">💾SaveLog</button>
    <button data-action="copy">📋コピー</button>
  `;

    document.body.appendChild(menu);

    const rect = anchorEl.getBoundingClientRect();
    menu.style.left = `${rect.right + 6}px`;
    menu.style.top = `${rect.top}px`;

    menu.addEventListener("click", e => {
        const action = e.target.dataset.action;
        if (!action) return;

        const blockLines = getBlockText(view.state, lineNumber);
        if (!blockLines || blockLines.length === 0) {
            console.warn("ブロックテキスト取得失敗", lineNumber);
            return;
        }

        if (action === "copy") {
            const bodyText = blockLines.join("\n");
            navigator.clipboard.writeText(bodyText).then(() => {
                // Optional: show a small toast or just let it succeed quietly
            }).catch(err => {
                console.error("Failed to copy:", err);
            });
            menu.remove();
            return;
        }

        const url = blockUrlBuilders(blockLines, action);
        insertMemoMark(view, lineNumber, action);

        if (url) window.location.href = url;
        menu.remove();
    });

    setTimeout(() => {
        document.addEventListener("click", function close() {
            menu.remove();
            document.removeEventListener("click", close);
        });
    }, 0);
}

class BlockHeadButtonMarker extends GutterMarker {
    constructor(view, from) {
        super();
        this.view = view;
        this.from = from;
    }

    toDOM() {
        const el = document.createElement("div");
        el.className = "cm-block-head-button";
        el.textContent = "●";

        el.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const line = this.view.state.doc.lineAt(this.from);
            showBlockMenu({
                view: this.view,
                lineNumber: line.number,
                anchorEl: el
            });
        });

        return el;
    }
}

export const blockHeadGutter = gutter({
    class: "cm-block-head-gutter",
    lineMarker(view, line) {
        if (!isBlockStartSafe(view.state, { from: line.from })) {
            return null;
        }
        return new BlockHeadButtonMarker(view, line.from);
    }
});

export const blockBodyDecoration = ViewPlugin.fromClass(
    class {
        constructor(view) {
            this.decorations = this.build(view);
        }

        update(update) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = this.build(update.view);
            }
        }

        build(view) {
            const decos = [];
            const { state } = view;

            for (const { from, to } of view.visibleRanges) {
                let pos = from;

                while (pos <= to) {
                    const line = state.doc.lineAt(pos);

                    if (line.text.length > 0 && isBlockStartSafe(state, { from: line.from })) {
                        let n = line.number;
                        while (n <= state.doc.lines) {
                            const l = state.doc.line(n);
                            if (n !== line.number && isBlockSeparatorLine(l.text)) break;

                            decos.push(
                                Decoration.line({
                                    class: "cm-block-body"
                                }).range(l.from)
                            );
                            n++;
                        }
                    }
                    pos = line.to + 1;
                }
            }
            return Decoration.set(decos);
        }
    },
    {
        decorations: v => v.decorations
    }
);


// ====== Hanging Indent (ぶら下げインデント) Plugin ======

export function computePrefixWidth(text) {
    const indentMatch = text.match(/^(\s*)/);
    let width = indentMatch ? indentMatch[1].length : 0;

    if (/^\s*- \[[ x]\] /.test(text)) {
        width += 6;
    } else if (/^\s*- /.test(text)) {
        width += 2;
    }
    return width;
}

export const hangingIndentPlugin = ViewPlugin.fromClass(
    class {
        constructor(view) {
            this.decorations = this.build(view);
        }
        update(update) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = this.build(update.view);
            }
        }
        build(view) {
            const decos = [];
            for (const { from, to } of view.visibleRanges) {
                let pos = from;
                while (pos <= to) {
                    const line = view.state.doc.lineAt(pos);
                    const prefixWidth = computePrefixWidth(line.text);
                    if (prefixWidth > 0) {
                        decos.push(
                            Decoration.line({
                                attributes: {
                                    style: `padding-left: ${prefixWidth}ch; text-indent: -${prefixWidth}ch;`
                                }
                            }).range(line.from)
                        );
                    }
                    pos = line.to + 1;
                }
            }
            // Ensure decorations are sorted by position for iOS WebKit compatibility
            decos.sort((a, b) => a.from - b.from);
            return Decoration.set(decos, true);
        }
    },
    { decorations: v => v.decorations }
);

export const nonEmptyLineDecoration = ViewPlugin.fromClass(
    class {
        constructor(view) {
            this.decorations = this.build(view);
        }
        update(update) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = this.build(update.view);
            }
        }
        build(view) {
            const decos = [];
            const { state } = view;
            for (const { from, to } of view.visibleRanges) {
                let pos = from;
                while (pos <= to) {
                    const line = state.doc.lineAt(pos);
                    if (line.text.length > 0) {
                        decos.push(
                            Decoration.line({
                                class: "cm-non-empty-line"
                            }).range(line.from)
                        );
                    }
                    pos = line.to + 1;
                }
            }
            return Decoration.set(decos);
        }
    },
    { decorations: v => v.decorations }
);
