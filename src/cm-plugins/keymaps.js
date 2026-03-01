import { keymap } from "https://esm.sh/@codemirror/view";
import { moveLineUp, moveLineDown } from "https://esm.sh/@codemirror/commands";

//====== 解析ユーティリティ ======

export function parseLine(lineText) {
    const match = lineText.match(/^(\s*)(- )?(.*)$/);
    const indent = match[1].length / 2;
    const isList = Boolean(match[2]);
    const content = match[3];

    return { indent, isList, content };
}

export function buildLine({ indent, isList, content }) {
    const spaces = "  ".repeat(indent);
    const bullet = isList ? "- " : "";
    return spaces + bullet + content;
}

//====== コマンド ======

export function indentCurrentLine(view) {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return;
    const pos = sel.head;
    const line = state.doc.lineAt(pos);

    const column = pos - line.from;
    const parsed = parseLine(line.text);

    let next;
    if (!parsed.isList) {
        next = { indent: 0, isList: true, content: parsed.content };
    } else {
        next = {
            indent: parsed.indent + 1,
            isList: true,
            content: parsed.content
        };
    }

    const newText = buildLine(next);

    view.dispatch({
        changes: {
            from: line.from,
            to: line.to,
            insert: newText
        },
        selection: {
            anchor: line.from + Math.min(column, newText.length) + 2
        }
    });
}

export function outdentCurrentLine(view) {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return;
    const pos = sel.head;
    const line = state.doc.lineAt(pos);

    const column = pos - line.from;
    const parsed = parseLine(line.text);

    if (!parsed.isList) return;

    let next;
    if (parsed.indent > 0) {
        next = {
            indent: parsed.indent - 1,
            isList: true,
            content: parsed.content
        };
    } else {
        next = {
            indent: 0,
            isList: false,
            content: parsed.content
        };
    }

    const newText = buildLine(next);

    view.dispatch({
        changes: {
            from: line.from,
            to: line.to,
            insert: newText
        },
        selection: {
            anchor: line.from + Math.min(column, newText.length) - 2
        }
    });
}

//====== キーマップ定義 ======

export const fixEmptyLineBackspace = keymap.of([
    {
        key: "Backspace",
        run(view) {
            const { state } = view;
            const sel = state.selection.main;
            if (!sel.empty) return false;

            const pos = sel.head;
            const line = state.doc.lineAt(pos);

            if (line.from === line.to && pos === line.from) {
                if (line.number === 1) return true;
                const prev = state.doc.line(line.number - 1);

                view.dispatch({
                    changes: {
                        from: prev.to,
                        to: line.to
                    },
                    selection: { anchor: prev.to }
                });

                return true;
            }
            return false;
        }
    }
]);

export const listEnterKeymap = keymap.of([{
    key: "Enter",
    run(view) {
        const { state } = view;
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        const text = line.text;

        const match = text.match(/^(\s*)(- )(?:\[( |x)\] )?(.*)$/);
        if (!match) return false;

        const indent = match[1];
        const bullet = match[2];
        const checkbox = match[3];
        const content = match[4];

        if (content.length === 0) {
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: "" }
            });
            return true;
        }

        let nextLine = indent + bullet;
        if (checkbox !== undefined) {
            nextLine += "[ ] ";
        }

        view.dispatch({
            changes: {
                from: pos,
                to: pos,
                insert: "\n" + nextLine
            },
            selection: {
                anchor: pos + 1 + nextLine.length
            }
        });

        return true;
    }
}]);

export function toggleListByKeyboard(view) {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return true;

    const line = state.doc.lineAt(sel.head);
    const text = line.text;
    const match = text.match(/^(\s*)(- )(\[(?: |x)\] )?(.*)$/);

    let next;
    if (!match) {
        next = `- ${text}`;
    } else {
        const indent = match[1];
        const checkbox = match[3];
        const content = match[4];

        if (!checkbox) {
            next = `${indent}- [ ] ${content}`;
        } else if (checkbox === "[ ] ") {
            next = `${indent}- [x] ${content}`;
        } else {
            next = content ? `${indent}${content}` : "";
        }
    }

    view.dispatch({
        changes: {
            from: line.from,
            to: line.to,
            insert: next
        },
        selection: { anchor: line.from + next.length }
    });

    return true;
}

export const listToggleKeymap = keymap.of([
    {
        key: "Mod-Enter",
        run: toggleListByKeyboard
    }
]);

export const indentKeymap = keymap.of([
    {
        key: "Tab",
        run(view) {
            indentCurrentLine(view);
            return true;
        }
    },
    {
        key: "Shift-Tab",
        run(view) {
            outdentCurrentLine(view);
            return true;
        }
    }
]);

export const moveLineKeymap = keymap.of([
    {
        key: "Alt-ArrowUp",
        run: moveLineUp
    },
    {
        key: "Alt-ArrowDown",
        run: moveLineDown
    }
]);
