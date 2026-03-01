import { ViewPlugin, Decoration, WidgetType } from "https://esm.sh/@codemirror/view";

// --- 正規表現 ---
const localLinkRE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const imageRE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/;

export function isBlockSeparatorLine(text) {
    if (!text) return true;              // 完全空行
    if (text.trim() === "") return true; // 空白だけの行
    if (/^#+\s/.test(text)) return true; // 見出し行（#）
    return false;
}

export function getIndentLevel(text) {
    const m = text.match(/^(\s*)/);
    return m ? Math.floor(m[1].length / 2) : 0;
}

// 画像プレビューウィジェット
class ImageWidget extends WidgetType {
    constructor(src, alt) {
        super();
        this.src = src;
        this.alt = alt;
    }

    toDOM() {
        const img = document.createElement("img");
        img.src = this.src;
        img.alt = this.alt;
        img.loading = "lazy";
        img.style.maxWidth = "100%";
        img.style.display = "block";
        img.style.margin = "6px 0";
        return img;
    }

    ignoreEvent() {
        return true;
    }
}

export const markdownLookPlugin = ViewPlugin.fromClass(
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
            const doneChildLines = new Set();
            const { state } = view;

            const ranges =
                view.visibleRanges.length > 0
                    ? view.visibleRanges
                    : [{ from: 0, to: state.doc.length }];

            for (const { from, to } of ranges) {
                let pos = from;

                while (pos <= to) {
                    const line = state.doc.lineAt(pos);
                    const text = line.text;

                    /* --- 見出し --- */
                    if (/^#{1,6}\s+/.test(text)) {
                        const level = text.match(/^#+/)[0].length;
                        decos.push(
                            Decoration.line({
                                class: "cm-md-heading cm-md-h" + Math.min(level, 3)
                            }).range(line.from)
                        );
                    }

                    /* --- 完了チェック --- */
                    else if (/^\s*- \[x\]\s+/.test(text)) {
                        const baseIndent = getIndentLevel(text);

                        decos.push(
                            Decoration.line({
                                class: "cm-md-checkbox-done"
                            }).range(line.from)
                        );

                        let n = line.number + 1;
                        while (n <= state.doc.lines) {
                            const next = state.doc.line(n);
                            const nextText = next.text;

                            if (nextText.trim() === "") {
                                n++;
                                continue;
                            }

                            const nextIndent = getIndentLevel(nextText);
                            if (nextIndent <= baseIndent) break;

                            doneChildLines.add(next.from);
                            n++;
                        }
                    }

                    /* --- 未完了チェック --- */
                    else if (/^\s*- \[ \]\s+/.test(text)) {
                        decos.push(
                            Decoration.line({
                                class: "cm-md-checkbox"
                            }).range(line.from)
                        );
                    }

                    /* --- 通常リスト --- */
                    else if (/^\s*- /.test(text)) {
                        decos.push(
                            Decoration.line({
                                class: "cm-md-list"
                            }).range(line.from)
                        );
                    }

                    /* --- Markdownリンク --- */
                    let lm;
                    while ((lm = localLinkRE.exec(text))) {
                        const start = line.from + lm.index + 1;
                        const end = start + lm[1].length;

                        decos.push(
                            Decoration.mark({
                                class: "cm-md-link",
                                attributes: {
                                    "data-url": lm[2]
                                }
                            }).range(start, end)
                        );
                    }

                    /* --- 画像プレビュー --- */
                    const im = text.match(imageRE);
                    if (im) {
                        decos.push(
                            Decoration.widget({
                                widget: new ImageWidget(im[2], im[1]),
                                side: 1
                            }).range(line.to)
                        );
                    }

                    pos = line.to + 1;
                }
            }

            /* --- 完了チェックの下位行をまとめて装飾 --- */
            [...doneChildLines]
                .sort((a, b) => a - b)
                .forEach(from => {
                    decos.push(
                        Decoration.line({
                            class: "cm-md-done-child"
                        }).range(from)
                    );
                });

            // CodeMirrorはソートされたデコレーションを要求するため、from順にソートする
            decos.sort((a, b) => {
                if (a.from !== b.from) {
                    return a.from - b.from;
                }
                // fromが同じ場合はstartSideでソート
                return (a.startSide || 0) - (b.startSide || 0);
            });

            return Decoration.set(decos, true);
        }
    },
    {
        decorations: v => v.decorations
    }
);
