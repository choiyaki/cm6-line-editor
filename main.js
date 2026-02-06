import { EditorView, keymap, lineNumbers, WidgetType, Decoration } from "https://esm.sh/@codemirror/view";
import { EditorState, StateField } from "https://esm.sh/@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands";
import { indentOnInput } from "https://esm.sh/@codemirror/language";


class LineButtonWidget extends WidgetType {
  constructor(lineNumber) {
    super();
    this.lineNumber = lineNumber;
    this._longPressTimer = null;
    this._longPressed = false;
  }

  toDOM(view) {
    const btn = document.createElement("button");
    btn.textContent = "";
    btn.className = "line-move-btn";
    btn.dataset.line = this.lineNumber;

    btn.onpointerdown = e => {
			if (view.composing) return;
      e.stopPropagation();
      this._longPressed = false;

      // ★ 長押し判定開始
      this._longPressTimer = setTimeout(() => {
        this._longPressed = true;
        startMoveSelect(view, this.lineNumber);
      }, 400); // ← 長押し判定時間（ms）
    };

    btn.onpointerup = e => {
			if (view.composing) return;
      e.stopPropagation();
      clearTimeout(this._longPressTimer);

      if (this._longPressed) return; // 長押し済みなら何もしない

      // ★ 短タップ
      handleShortTap(view, this.lineNumber);
    };

    btn.onpointercancel = () => {
      clearTimeout(this._longPressTimer);
    };

    return btn;
  }
}

const lineActionExtension = EditorView.updateListener.of(update => {
  update.view.plugin(lineActionField)?.value?.forEach(d => {
    if (d.widget instanceof LineActionWidget) {
      d.widget.view = update.view;
    }
  });
});

const lineButtonField = StateField.define({
  create(state) {
    // ★ 初期描画時に必ず作る
    return buildLineButtons(state);
  },

  update(value, tr) {
    // 行数 or ドキュメントが変わったときだけ再構築
    if (!tr.docChanged) return value;
    return buildLineButtons(tr.state);
  },

  provide: f => EditorView.decorations.from(f)
});

const lineButtonViewInjector = EditorView.updateListener.of(update => {
  update.view
    .plugin(lineButtonField)
    ?.forEach(decoration => {
      const w = decoration.widget;
      if (w instanceof LineButtonWidget) {
        w.view = update.view;
      }
    });
});

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


function isComposing(view) {
  return view.composing;
}

function handleShortTap(view, lineNumber) {
  // 移動元が選択中なら → 移動先として使う
  if (view._moveSourceLine != null) {
    const from = view.state.doc.line(view._moveSourceLine);
    const to = view.state.doc.line(lineNumber);

    moveLine(view, from, to);
    view._moveSourceLine = null;
    updateMoveUI(view);
    return;
  }

  // 通常：1行下へ
  const from = view.state.doc.line(lineNumber);
  const to = view.state.doc.line(lineNumber + 1);
  if (!to) return;

  moveLine(view, from, to);
}

function startMoveSelect(view, lineNumber) {
  view._moveSourceLine = lineNumber;
  updateMoveUI(view);
}

function updateMoveUI(view) {
  document.querySelectorAll(".line-move-btn").forEach(btn => {
    const line = Number(btn.dataset.line);
    const selected = line === view._moveSourceLine;

    btn.classList.toggle("selected", selected);
    btn.textContent = selected ? "" : "";
  });
}


function buildLineButtons(state) {
  const widgets = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);

    widgets.push(
      Decoration.widget({
        widget: new LineButtonWidget(i),
        side: 1
      }).range(line.to)
    );
  }

  return Decoration.set(widgets);
}

function buildCursorLineButtons(state, view) {
  if (!view) return Decoration.none;

  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);

  return Decoration.set([
    Decoration.widget({
      widget: new CursorLineButtons(view, line),
      side: 1
    }).range(line.to)
  ]);
}



function buildLineActions(state) {
  const widgets = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);

    widgets.push(
      Decoration.widget({
        widget: new LineActionWidget(null, line),
        side: 1,
        pos: line.to
      })
    );
  }

  return widgets;
}


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
    },

    touchend(event, view) {
      const startX = view._swipeStartX;
      const startY = view._swipeStartY;
      if (startX == null || startY == null) return;

      const t = event.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      // 縦スクロールを優先
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;

      if (dx > 0) {
        indentCurrentLine(view);
      } else {
        outdentCurrentLine(view);
      }

      view._swipeStartX = null;
      view._swipeStartY = null;
    }
  });
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
		//lineButtonField,
		lineButtonViewInjector,
		autosaveExtension,
		fixEmptyLineBackspace,
		fixEmptyLineClick,
		listEnterKeymap,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap
    ])
  ]
});

new EditorView({
  state,
  parent: document.getElementById("editor")
});