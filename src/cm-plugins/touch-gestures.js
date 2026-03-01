import { EditorView } from "https://esm.sh/@codemirror/view";
import { moveLineUp, moveLineDown } from "https://esm.sh/@codemirror/commands";
import { indentCurrentLine, outdentCurrentLine } from "./keymaps.js";

// ====== Swipe Indent ======

function cleanup(view) {
    view._swipeStartX = null;
    view._swipeStartY = null;
    view._swipeStartSelection = null;
}

export function swipeIndentExtension() {
    return EditorView.domEventHandlers({
        touchstart(event, view) {
            if (!view.hasFocus) return;
            if (event.touches.length !== 1) return;

            const t = event.touches[0];
            view._swipeStartX = t.clientX;
            view._swipeStartY = t.clientY;

            const sel = view.state.selection.main;
            view._swipeStartSelection = {
                anchor: sel.anchor,
                head: sel.head
            };
        },

        touchend(event, view) {
            const startX = view._swipeStartX;
            const startY = view._swipeStartY;
            if (startX == null || startY == null) return;

            const t = event.changedTouches[0];
            const dx = t.clientX - startX;
            const dy = t.clientY - startY;

            const sel = view.state.selection.main;
            const startSel = view._swipeStartSelection;

            if (
                startSel &&
                (sel.anchor !== startSel.anchor ||
                    sel.head !== startSel.head)
            ) {
                cleanup(view);
                return;
            }

            if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) {
                cleanup(view);
                return;
            }

            if (dx > 0) {
                indentCurrentLine(view);
            } else {
                outdentCurrentLine(view);
            }

            cleanup(view);
        }
    });
}

// ====== Right Side Focused Edit ======

export function rightSideFocusedEditExtension() {
    let startX = null;
    let startY = null;
    let isRightSide = false;
    let hasHandledVertical = false;

    return EditorView.domEventHandlers({
        touchstart(event, view) {
            if (!view.hasFocus) return;
            if (!view.state.selection.main.empty) return;
            if (event.touches.length !== 1) return;

            const t = event.touches[0];
            const rect = view.dom.getBoundingClientRect();
            const localX = t.clientX - rect.left;

            if (localX < rect.width * 0.75) return;

            isRightSide = true;
            startX = t.clientX;
            startY = t.clientY;
            hasHandledVertical = false;

            if (event.cancelable) event.preventDefault();
        },

        touchmove(event, view) {
            if (!view.state.selection.main.empty) return;
            if (!isRightSide) return;
            if (startX == null || startY == null) return;

            const t = event.touches[0];
            const dx = t.clientX - startX;
            const dy = t.clientY - startY;

            const absX = Math.abs(dx);
            const absY = Math.abs(dy);
            const threshold = 24;

            if (absX > absY) return;
            if (absY < threshold) return;

            if (!hasHandledVertical) {
                if (!view.state.selection.main.empty) return;
                if (dy < 0) {
                    moveLineUp(view);
                } else {
                    moveLineDown(view);
                }
                hasHandledVertical = true;
            }

            if (event.cancelable) event.preventDefault();
        },

        touchend() {
            startX = null;
            startY = null;
            isRightSide = false;
            hasHandledVertical = false;
        }
    });
}

// ====== List Toggle on Tap/Click ======

export function toggleListIfNeeded(view, pos) {
    const { state } = view;
    const line = state.doc.lineAt(pos);
    const text = line.text;

    const match = text.match(/^(\s*)(- )(\[(?: |x)\] )?(.*)$/);
    if (!match) return;

    const indentSpaces = match[1];
    const hasCheckbox = Boolean(match[3]);
    const checkboxText = match[3];
    const content = match[4];
    if (content.trim() === "") {
        return;
    }

    const bulletFrom = line.from + indentSpaces.length;

    const toggleLength = hasCheckbox ? 6 : 2;
    const bulletTo = bulletFrom + toggleLength;

    if (pos < bulletFrom || pos > bulletTo) return;

    let next;

    if (!hasCheckbox) {
        next = `${indentSpaces}- [ ] ${content}`;
    } else if (checkboxText === "[ ] ") {
        next = `${indentSpaces}- [x] ${content}`;
    } else {
        next = `${indentSpaces}- ${content}`;
    }

    view.dispatch({
        changes: {
            from: line.from,
            to: line.to,
            insert: next
        },
        selection: {
            anchor: line.from + next.length
        }
    });
}

export function listToggleExtension() {
    return EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.button !== 0) return;

            const pos = view.posAtCoords({
                x: event.clientX,
                y: event.clientY
            });

            if (pos == null) return;

            toggleListIfNeeded(view, pos);
        }
    });
}
