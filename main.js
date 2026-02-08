import {
  EditorView,
  ViewPlugin,
  gutter,
  GutterMarker,
  keymap,
	Decoration
} from "https://esm.sh/@codemirror/view";

import {
  EditorState,
  StateEffect
} from "https://esm.sh/@codemirror/state";

import {
  defaultKeymap,
  history,
  historyKeymap
} from "https://esm.sh/@codemirror/commands";

import {
  indentOnInput
} from "https://esm.sh/@codemirror/language";

const requestMoveLine = StateEffect.define();


class MoveLineMarker extends GutterMarker {
  toDOM(view) {
    const btn = document.createElement("button");
    btn.className = "gutter-move-btn";
    btn.textContent = view._moveSourceLine ? "" : "▽";

    let longPressTimer = null;
    let longPressed = false;

    btn.onpointerdown = e => {
      if (view.composing) return;
      e.preventDefault();
      e.stopPropagation();

      longPressed = false;
      longPressTimer = setTimeout(() => {
        longPressed = true;

        const pos = view.posAtCoords({
          x: e.clientX,
          y: e.clientY
        });
        if (pos == null) return;

        const line = view.state.doc.lineAt(pos);
        startMoveSelect(view, line.number);
        view.dispatch({});
      }, 400);
    };

    btn.onpointerup = e => {
      if (view.composing) return;
      e.preventDefault();
      e.stopPropagation();

      clearTimeout(longPressTimer);
      if (longPressed) return;

      const pos = view.posAtCoords({
        x: e.clientX,
        y: e.clientY
      });
      if (pos == null) return;

      const line = view.state.doc.lineAt(pos);
      handleShortTap(view, line.number);
      view.dispatch({});
    };

    btn.onpointercancel = () => {
      clearTimeout(longPressTimer);
    };

    return btn;
  }

  eq() {
    return false; // 常に再描画
  }
}

const moveLinePlugin = ViewPlugin.fromClass(class {
  update(update) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(requestMoveLine)) {
          console.log("move requested:", effect.value);

          const lineNumber = effect.value;
          const from = update.state.doc.line(lineNumber);
          const to = update.state.doc.line(lineNumber + 1);
          if (!to) return;

          moveLine(update.view, from, to);
        }
      }
    }
  }
});

const moveLineGutter = gutter({
  class: "cm-move-line-gutter",

  lineMarker(view, line) {
	  if (!line) return null;
	  return new MoveLineMarker(line.number);
	},
	
  initialSpacer() {
    const spacer = document.createElement("div");
    spacer.style.width = "18px";
    return spacer;
  }
});

function handleShortTap(view, lineNumber) {
  console.log("handleShortTap", lineNumber);

  const doc = view.state.doc;

  if (view._moveSourceLine != null) {
    const from = doc.line(view._moveSourceLine);
    const to = doc.line(lineNumber);

    moveLine(view, from, to);
    view._moveSourceLine = null;
    return;
  }

  // ★ 最終行ガード
  if (lineNumber >= doc.lines) return;

  const from = doc.line(lineNumber);
  const to = doc.line(lineNumber + 1);

  moveLine(view, from, to);
}

function startMoveSelect(view, lineNumber) {
  view._moveSourceLine = lineNumber;
}

const fixEmptyLineBackspace = keymap.of([
  {
    key: "Backspace",
    run(view) {
      const { state } = view;
      const sel = state.selection.main;
      if (!sel.empty) return false;

      const pos = sel.head;
      const line = state.doc.lineAt(pos);

      // ★ 空行 & 行頭
      if (line.from === line.to && pos === line.from) {
        if (line.number === 1) return true;
        const prev = state.doc.line(line.number - 1);

        view.dispatch({
          changes: {
            from: prev.to,
            to: line.to // 改行を消す
          },
          selection: { anchor: prev.to }
        });

        return true; // ★ defaultKeymap を止める
      }

      return false; // それ以外は defaultKeymap に任せる
    }
  }
]);

const fixEmptyLineClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return;

    const pos = view.posAtCoords({
      x: event.clientX,
      y: event.clientY
    });

    if (pos == null) return;

    const line = view.state.doc.lineAt(pos);

    // ★ 空行ならカーソルを行頭に固定
    if (line.from === line.to) {
      view.dispatch({
        selection: { anchor: line.from }
      });

      event.preventDefault();
    }
  }
});


const listEnterKeymap = keymap.of([{
  key: "Enter",
  run(view) {
    const { state } = view;
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);

    const text = line.text;

    // - または - [ ] / - [x]
    const match = text.match(/^(\s*)(- )(?:\[( |x)\] )?(.*)$/);
    if (!match) return false; // 通常の Enter に任せる

    const indent = match[1];
    const bullet = match[2];
    const checkbox = match[3]; // undefined | " " | "x"
    const content = match[4];

    // ★ 中身が空ならリスト解除
    if (content.length === 0) {
      view.dispatch({
        changes: {
          from: line.from,
          to: line.to,
          insert: ""
        }
      });
      return true;
    }

    // 次行に挿入する文字列
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

    return true; // ★ デフォルト Enter を止める
  }
}]);


function moveLine(view, fromLine, toLine) {
  if (!toLine || fromLine.number === toLine.number) return;

  const doc = view.state.doc;

  const fromHasBreak = fromLine.to < doc.length;
  const fromText = fromLine.text + (fromHasBreak ? "\n" : "");

  const changes = [];

  // 元の行を削除
  changes.push({
    from: fromLine.from,
    to: fromLine.to + (fromHasBreak ? 1 : 0)
  });

  // 挿入位置を計算
  let insertPos;
  if (fromLine.number < toLine.number) {
    // 下へ移動
    insertPos = toLine.to;
    if (toLine.to < doc.length) insertPos += 1;
  } else {
    // 上へ移動
    insertPos = toLine.from;
  }

  changes.push({
    from: insertPos,
    insert: fromText
  });

  view.dispatch({ changes });
}



function listToggleExtension() {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      // タッチでも反応させるなら pointerdown でもOK
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

function toggleListIfNeeded(view, pos) {
  const { state } = view;
  const line = state.doc.lineAt(pos);
  const text = line.text;

  const match = text.match(/^(\s*)(- )(\[(?: |x)\] )?(.*)$/);
  if (!match) return;

  const indentSpaces = match[1];
  const hasCheckbox = Boolean(match[3]);
  const checkboxText = match[3]; // "[ ] " or "[x] "
  const content = match[4];

  const bulletFrom = line.from + indentSpaces.length;

  // 反応エリアの長さを切り替える
  const toggleLength = hasCheckbox ? 6 : 2;
  const bulletTo = bulletFrom + toggleLength;

  if (pos < bulletFrom || pos > bulletTo) return;

  let next;

  if (!hasCheckbox) {
    // - → - [ ]
    next = `${indentSpaces}- [ ] ${content}`;
  } else if (checkboxText === "[ ] ") {
    // [ ] → [x]
    next = `${indentSpaces}- [x] ${content}`;
  } else {
    // [x] → 元のリストに戻す
    next = `${indentSpaces}- ${content}`;
  }

  view.dispatch({
    changes: {
      from: line.from,
      to: line.to,
      insert: next
    }
  });
}


function indentCurrentLine(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);

  const parsed = parseLine(line.text);

  let next;

  if (!parsed.isList) {
    // 1回目：リスト化
    next = {
      indent: 0,
      isList: true,
      content: parsed.content
    };
  } else {
    // 2回目以降：インデント
    next = {
      indent: parsed.indent + 1,
      isList: true,
      content: parsed.content
    };
  }

  view.dispatch({
    changes: {
      from: line.from,
      to: line.to,
      insert: buildLine(next)
    }
  });
}

function outdentCurrentLine(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);

  const parsed = parseLine(line.text);

  if (!parsed.isList) return;

  let next;

  if (parsed.indent > 0) {
    // インデントを戻す
    next = {
      indent: parsed.indent - 1,
      isList: true,
      content: parsed.content
    };
  } else {
    // リスト解除
    next = {
      indent: 0,
      isList: false,
      content: parsed.content
    };
  }

  view.dispatch({
    changes: {
      from: line.from,
      to: line.to,
      insert: buildLine(next)
    }
  });
}

function swipeIndentExtension() {
  return EditorView.domEventHandlers({
    touchstart(event, view) {
      if (event.touches.length !== 1) return;

      const t = event.touches[0];
      view._swipeStartX = t.clientX;
      view._swipeStartY = t.clientY;

      // ★ 選択状態を保存
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

      // ★ 選択が変わっていたら → スワイプ無効
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

      // 縦スクロール優先
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

function cleanup(view) {
  view._swipeStartX = null;
  view._swipeStartY = null;
  view._swipeStartSelection = null;
}

function parseLine(lineText) {
  const match = lineText.match(/^(\s*)(- )?(.*)$/);

  const indent = match[1].length / 2;
  const isList = Boolean(match[2]);
  const content = match[3];

  return { indent, isList, content };
}

function buildLine({ indent, isList, content }) {
  const spaces = "  ".repeat(indent);
  const bullet = isList ? "- " : "";
  return spaces + bullet + content;
}


function getIndentInfo(lineText) {
  const indentMatch = lineText.match(/^(\s*)/);
  const baseIndent = indentMatch[1].length;

  // checkbox
  if (/^\s*- \[( |x)\] /.test(lineText)) {
    return { indent: baseIndent + 6 };
  }

  // list
  if (/^\s*- /.test(lineText)) {
    return { indent: baseIndent + 2 };
  }

  // normal
  return { indent: baseIndent };
}


function computePrefixWidth(text) {
  // 先頭スペース
  const indentMatch = text.match(/^(\s*)/);
  const spaces = indentMatch ? indentMatch[1].length : 0;

  // 2スペース = 1階層 → 1階層 = 2ch
  let width = spaces; // ch 単位で扱う

  if (/^\s*- \[[ x]\] /.test(text)) {
    width += 6; // "- [ ] "
  } else if (/^\s*- /.test(text)) {
    width += 2; // "- "
  }

  return width;
}

const hangingIndentPlugin = ViewPlugin.fromClass(
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
          const text = line.text;

          const prefixWidth = computePrefixWidth(text);
          if (prefixWidth > 0) {
            // body の開始位置
            const bodyFrom = line.from;

            decos.push(
              Decoration.mark({
                class: "cm-body",
                attributes: {
                  style: `--prefix-width: ${prefixWidth}ch`
                }
              }).range(bodyFrom, line.to)
            );
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



const STORAGE_KEY = "cm6-line-editor-doc";

function saveToLocal(state) {
  localStorage.setItem(
    STORAGE_KEY,
    state.doc.toString()
  );
}

function loadFromLocal() {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

const autosaveExtension = EditorView.updateListener.of(update => {
  if (update.docChanged) {
    saveToLocal(update.state);
  }
});

const state = EditorState.create({
  doc: loadFromLocal(),
  extensions: [
		EditorView.lineWrapping,
		swipeIndentExtension(),
		listToggleExtension(),
    history(),
    indentOnInput(),
		autosaveExtension,
		fixEmptyLineBackspace,
		fixEmptyLineClick,
		listEnterKeymap,
		hangingIndentPlugin,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap
    ]),
		moveLineGutter,
		moveLinePlugin
  ]
});

new EditorView({
	state,
  parent: document.getElementById("editor")
});