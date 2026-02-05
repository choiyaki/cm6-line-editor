import { EditorView, keymap, lineNumbers, WidgetType, Decoration } from "https://esm.sh/@codemirror/view";
import { EditorState, StateField } from "https://esm.sh/@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands";
import { indentOnInput } from "https://esm.sh/@codemirror/language";


class LineButtonWidget extends WidgetType {
  constructor(view, lineNumber) {
    super();
    this.view = view;
    this.lineNumber = lineNumber;
  }

  toDOM() {
    const btn = document.createElement("button");
    btn.textContent = "↑↓";
    btn.className = "line-move-btn";

    let timer = null;
    let longPressed = false;

    btn.onpointerdown = e => {
      e.stopPropagation();
      longPressed = false;

      timer = setTimeout(() => {
        longPressed = true;
        startMoveSelect(this.view, this.lineNumber);
      }, 300);
    };

    btn.onpointerup = e => {
      clearTimeout(timer);

      if (longPressed) return;

      handleShortTap(this.view, this.lineNumber);
    };

    btn.onpointercancel = () => {
      clearTimeout(timer);
    };

    return btn;
  }

  ignoreEvent() {
    return false;
  }
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
    btn.classList.toggle(
      "selected",
      line === view._moveSourceLine
    );
  });
}

const lineButtonField = StateField.define({
  create(state) {
    return Decoration.none;
  },

  update(_, tr) {
    return buildLineButtons(tr.state, tr.view);
  },

  provide: f => EditorView.decorations.from(f)
});


function buildLineButtons(state) {
  const widgets = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);

    widgets.push(
      Decoration.widget({
        widget: new LineButtonWidget(null, i),
        side: 1
      }).range(line.to)   // ← ★これが必須
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

const lineActionExtension = EditorView.updateListener.of(update => {
  update.view.plugin(lineActionField)?.value?.forEach(d => {
    if (d.widget instanceof LineActionWidget) {
      d.widget.view = update.view;
    }
  });
});



function moveLine(view, fromLine, toLine) {
  if (!toLine || fromLine.number === toLine.number) return;

  const changes = [];

  changes.push({
    from: fromLine.from,
    to: fromLine.to + 1
  });

  let insertPos = toLine.from;
  if (fromLine.number < toLine.number) {
    insertPos = toLine.to + 1;
  }

  changes.push({
    from: insertPos,
    insert: fromLine.text + "\n"
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

const state = EditorState.create({
  doc: "Swipe right to indent\nSwipe left to outdent\nSwipe right to indent\nSwipe left to outdent\nSwipe right to indent\nSwipe left to outdent",
  extensions: [
		EditorView.lineWrapping,
		swipeIndentExtension(),
		listToggleExtension(),
    history(),
    indentOnInput(),
		lineButtonField,
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