import { ViewPlugin } from "https://esm.sh/@codemirror/view";
import { EditorSelection } from "https://esm.sh/@codemirror/state";
import { isComposing } from "../firebase-sync.js";
import { parseLine, buildLine } from "./keymaps.js";

// ====== Selection Move & Transform ======

function moveSelectionByLines(view, dir) {
    const { state } = view;
    const sel = state.selection.main;
    if (sel.empty) return;

    let doc = state.doc;
    const s = sel.from;
    const e = sel.to;

    if (
        doc.length > 0 &&
        doc.sliceString(doc.length - 1, doc.length) !== "\n"
    ) {
        view.dispatch({
            changes: {
                from: doc.length,
                to: doc.length,
                insert: "\n"
            }
        });
        doc = view.state.doc;
    }

    let fromLine = doc.lineAt(s);
    let toLine = doc.lineAt(e);

    if (dir < 0) {
        if (fromLine.number === 1) return;

        const upperLine = doc.line(fromLine.number - 1);
        const upperText = doc.sliceString(upperLine.from, upperLine.to + 1);
        const blockText = doc.sliceString(fromLine.from, toLine.to + 1);

        view.dispatch({
            changes: {
                from: upperLine.from,
                to: toLine.to + 1,
                insert: blockText + upperText
            },
            selection: EditorSelection.range(
                s - (upperLine.length + 1),
                e - (upperLine.length + 1)
            ),
            scrollIntoView: true
        });

        return;
    }

    if (dir > 0) {
        if (toLine.number === doc.lines) return;

        const lowerLine = doc.line(toLine.number + 1);
        const blockText = doc.sliceString(fromLine.from, toLine.to + 1);
        const lowerText = doc.sliceString(lowerLine.from, lowerLine.to + 1);

        view.dispatch({
            changes: {
                from: fromLine.from,
                to: lowerLine.to + 1,
                insert: lowerText + blockText
            },
            selection: EditorSelection.range(
                s + (lowerLine.length + 1),
                e + (lowerLine.length + 1)
            ),
            scrollIntoView: true
        });
    }
}

function forEachSelectedLineWithDelta(view, fn) {
    const { state } = view;
    const sel = state.selection.main;
    if (sel.empty) return;

    const doc = state.doc;
    const fromLine = doc.lineAt(sel.from);
    const toLine = doc.lineAt(sel.to);

    const changes = [];
    let deltaFrom = 0;
    let deltaTo = 0;

    for (let n = fromLine.number; n <= toLine.number; n++) {
        const line = doc.line(n);
        const oldText = line.text;
        const newText = fn(oldText, n);

        if (newText == null || newText === oldText) continue;

        const diff = newText.length - oldText.length;

        if (line.from < sel.from) {
            deltaFrom += diff;
            deltaTo += diff;
        } else if (line.from < sel.to) {
            deltaTo += diff;
        }

        changes.push({
            from: line.from,
            to: line.to,
            insert: newText
        });
    }

    if (!changes.length) return;

    view.dispatch({
        changes,
        selection: EditorSelection.range(
            sel.from + deltaFrom,
            sel.to + deltaTo
        )
    });
}

function toggleCheckboxSelection(view) {
    forEachSelectedLineWithDelta(view, text => {
        if (/^\s*- \[ \]\s+/.test(text)) {
            return text.replace(/^(\s*)- \[ \]\s+/, "$1- [x] ");
        }
        if (/^\s*- \[x\]\s+/.test(text)) {
            return text.replace(/^(\s*)- \[x\]\s+/, "$1- ");
        }
        if (/^\s*- /.test(text)) {
            return text.replace(/^(\s*)- /, "$1- [ ] ");
        }
        return null;
    });
}

function indentSelection(view) {
    forEachSelectedLineWithDelta(view, text => {
        const p = parseLine(text);
        if (!p.isList) {
            return buildLine({ indent: 0, isList: true, content: p.content });
        }
        return buildLine({ indent: p.indent + 1, isList: true, content: p.content });
    });
}

function outdentSelection(view) {
    forEachSelectedLineWithDelta(view, text => {
        const p = parseLine(text);
        if (!p.isList) return null;
        if (p.indent > 0) {
            return buildLine({ indent: p.indent - 1, isList: true, content: p.content });
        }
        return p.content;
    });
}

// ====== Poup Plugin ======

export const selectionMovePopup = ViewPlugin.fromClass(
    class {
        constructor(view) {
            this.view = view;
            this.dom = document.createElement("div");
            this.dom.className = "cm-selection-move-popup";

            this.dom.addEventListener("mousedown", e => {
                e.preventDefault();
                e.stopPropagation();
            });

            this.dom.innerHTML = `
        <button data-act="toggle">✔︎</button>
        <button data-dir="up">↑</button>
        <button data-dir="down">↓</button>
        <button data-dir="left">←</button>
        <button data-dir="right">→</button>
      `;

            this.dom.addEventListener("click", e => {
                const act = e.target.dataset.act;
                const dir = e.target.dataset.dir;

                if (act === "toggle") {
                    toggleCheckboxSelection(view);
                    return;
                }

                if (dir === "up") moveSelectionByLines(view, -1);
                if (dir === "down") moveSelectionByLines(view, 1);
                if (dir === "left") outdentSelection(view);
                if (dir === "right") indentSelection(view);
            });

            view.dom.appendChild(this.dom);
            this.updateVisibility();
        }

        update(update) {
            if (
                update.selectionSet ||
                update.docChanged ||
                update.viewportChanged ||
                update.focusChanged
            ) {
                this.updateVisibility();
            }
        }

        updateVisibility() {
            const sel = this.view.state.selection.main;

            if (
                sel.empty ||
                !this.view.hasFocus ||
                isComposing
            ) {
                this.dom.style.display = "none";
                return;
            }

            requestAnimationFrame(() => {
                let coords;

                try {
                    const from = Math.min(sel.from, sel.head);
                    const line = this.view.state.doc.lineAt(from);
                    const anchorPos = Math.max(from, line.from);

                    coords = this.view.coordsAtPos(anchorPos);
                } catch {
                    this.dom.style.display = "none";
                    return;
                }

                if (!coords) {
                    this.dom.style.display = "none";
                    return;
                }

                const editorRect = this.view.dom.getBoundingClientRect();

                this.dom.style.display = "flex";
                this.dom.style.top = `${coords.top - editorRect.top - 44}px`;
                this.dom.style.left = `${coords.left - editorRect.left}px`;
            });
        }

        destroy() {
            this.dom.remove();
        }
    }
);
