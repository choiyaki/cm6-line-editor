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
  historyKeymap,
	moveLineUp,
	moveLineDown
} from "https://esm.sh/@codemirror/commands";

import {
  indentOnInput
} from "https://esm.sh/@codemirror/language";

const requestMoveLine = StateEffect.define();


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


// --- 右半分専用の操作（タップでカーソル、上下スワイプで行入れ替え） ---
function rightSideSwipeMoveExtension() {
  let startX = 0;
  let startY = 0;
  let hasMovedInThisSwipe = false;
  let isRightSide = false;

  return EditorView.domEventHandlers({
		touchstart(event, view) {
		  if (event.touches.length !== 1) return;
		
		  const rect = view.dom.getBoundingClientRect();
		  const touch = event.touches[0];
		  const x = touch.clientX - rect.left;
		
		  if (x > rect.width * 0.75) {
		    isRightSide = true;
		    startX = touch.clientX;
		    startY = touch.clientY;
		    hasMovedInThisSwipe = false;
				
				if (!view.hasFocus) {
          view.focus();
          const pos = view.posAtCoords({ x: touch.clientX, y: touch.clientY });
          if (pos !== null) {
            view.dispatch({ 
              selection: { anchor: pos, head: pos },
              scrollIntoView: true // ★ false から true に変更
            });
          }
        }


		
		    // --- 追加: キーボード未表示時でもフォーカスを強制する ---
		    if (!view.hasFocus) {
		      view.focus();
		    }
		
		    // 右半分でのスクロールを防止
		    if (event.cancelable) event.preventDefault();
		  } else {
		    isRightSide = false;
		  }
		},
		


    touchmove(event, view) {
      if (!isRightSide || hasMovedInThisSwipe) return;

      const touch = event.touches[0];
      const diffY = touch.clientY - startY;
      const threshold = 30;

      if (Math.abs(diffY) > threshold) {
        if (diffY < 0) {
          moveLineUp(view);
        } else {
          moveLineDown(view);
        }
        hasMovedInThisSwipe = true;
      }
      
      // 右側での移動中は常にスクロールを阻止
      if (isRightSide && event.cancelable) event.preventDefault();
    },

    touchend(event, view) {
      if (!isRightSide) return;

      if (!hasMovedInThisSwipe) {
        const touch = event.changedTouches[0];
        const pos = view.posAtCoords({ x: touch.clientX, y: touch.clientY });
        if (pos !== null) {
          view.dispatch({
            selection: { anchor: pos, head: pos },
            scrollIntoView: true,
            userEvent: "select"
          });
        }
      }

      isRightSide = false;
      hasMovedInThisSwipe = false;
    }
  });
}

function isBlockStartSafe(state, lineDesc) {
  if (!lineDesc || lineDesc.from == null) return false;

  const line = state.doc.lineAt(lineDesc.from);

  if (line.text.length === 0) return false;
  if (line.number === 1) return true;

  const prev = state.doc.line(line.number - 1);
  return prev.text.length === 0;
}

function blockHeight(view, startLineDesc) {
  const state = view.state;
  const doc = state.doc;

  // gutter から渡ってくるのは lineDesc
  const startLine = doc.lineAt(startLineDesc.from);

  let height = 0;

  for (let n = startLine.number; n <= doc.lines; n++) {
    const line = doc.line(n);

    // 各行の実描画高さを加算
    const block = view.lineBlockAt(line.from);
    height += block.height;

    // 先頭以外で空行が来たらブロック終了
    if (n !== startLine.number && line.text.length === 0) {
      break;
    }
  }

  return height;
}
class BlockGutterMarker extends GutterMarker {
  constructor(height, lineFrom, view) {
    super();
    this.height = height;
    this.lineFrom = lineFrom; // ★ 行番号ではなく from を保存
    this.view = view;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-block-gutter";
    el.style.height = this.height + "px";

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const state = this.view.state;

      // ★ クリック時に「今の」lineNumber を計算
      const line = state.doc.lineAt(this.lineFrom);

      showBlockMenu({
        view: this.view,
        lineNumber: line.number,
        anchorEl: el
      });
    });

    return el;
  }
}

const blockGutter = gutter({
  class: "cm-block-gutter-container",

  lineMarker(view, line) {
    if (!isBlockStartSafe(view.state, { from: line.from })) return null;

    const h = blockHeight(view, line);
    return new BlockGutterMarker(h, line.from, view);
  }
});

function getBlockText(state, startLineNumber) {
	console.log("ok");
  const lines = [];
  const doc = state.doc;
  let n = startLineNumber;

  while (n <= doc.lines) {
    const line = doc.line(n);
    if (n !== startLineNumber && line.text.length === 0) break;

    lines.push(line.text);
    n++;
  }

  return lines;
}

function buildScrapboxUrl(blockLines,actions) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const date = encodeURIComponent(`${yyyy}${mm}${dd}日誌`);
  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
	const body = encodeURIComponent(bodyText);
  return `sbporter://scrapbox.io/choiyaki/${date}?body=${body}`;
}

function blockUrlBuilders(blockLines,action) {
	const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
	if(action === "scrapbox") {
		alert(action)
    const date = encodeURIComponent(`${yyyy}${mm}${dd}日誌`);
	  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
		const body = encodeURIComponent(bodyText);
	  return `sbporter://scrapbox.io/choiyaki/${date}?body=${body}`;
  } else if(action === "choidiary"){
		const date = `${yyyy}${mm}${dd}`;
	  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
		const body = encodeURIComponent(bodyText);
	  return `touch-https://scrapbox.io/choidiary/${date}?body=${body}`;
  }else if(action === "SaveLog"){
	  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
		const body = encodeURIComponent(bodyText);
	  return `shortcuts://run-shortcut?name=Choiyakiをmd保存&input=${body}`;
  }
};

const blockBodyDecoration = ViewPlugin.fromClass(
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

          // ブロック先頭
          if (
            line.text.length > 0 &&
            isBlockStartSafe(state, { from: line.from })
          ) {
            let n = line.number;
            while (n <= state.doc.lines) {
              const l = state.doc.line(n);
              if (n !== line.number && l.text.length === 0) break;

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

function insertMemoMark(view, lineNumber, action  ) {
	
  if (!view || typeof lineNumber !== "number") return;

  const doc = view.state.doc;
  if (lineNumber < 1 || lineNumber > doc.lines) return;

  const line = doc.line(lineNumber);

  if (line.text.startsWith("📝")||line.text.startsWith("📓")||line.text.startsWith("💾")) return;
	if(action === "scrapbox"){
		view.dispatch({
	    changes: {
	      from: line.from,
	      insert: "📝"
	    }
	  });
	} else if(action === "choidiary"){
		view.dispatch({
	    changes: {
	      from: line.from,
	      insert: "📓"
	    }
	  });
	} else {
		view.dispatch({
	    changes: {
	      from: line.from,
	      insert: "💾"
	    }
	  });
	};
  
}

function showBlockMenu({ view, lineNumber, anchorEl }) {
  document.querySelectorAll(".cm-block-menu").forEach(el => el.remove());

  const menu = document.createElement("div");
  menu.className = "cm-block-menu";

  menu.innerHTML = `
    <button data-action="scrapbox">📝Choiyaki</button>
    <button data-action="choidiary">📓日記帳</button>
    <button data-action="SaveLog">💾SaveLog</button>
  `;

  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${rect.right + 6}px`;
  menu.style.top = `${rect.top}px`;

  menu.addEventListener("click", e => {
	  const action = e.target.dataset.action;
	  if (!action) return;
	
	  const blockLines = getBlockText(view.state, lineNumber);
	
	
	  const url = blockUrlBuilders(blockLines,action);
		
		insertMemoMark(view, lineNumber, action);
	
	  window.location.href = url;
	
	  menu.remove();
	});

  setTimeout(() => {
    document.addEventListener("click", function close() {
      menu.remove();
      document.removeEventListener("click", close);
    });
  }, 0);
}



const nonEmptyLineDecoration = ViewPlugin.fromClass(
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
  {
    decorations: v => v.decorations
  }
);



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
		rightSideSwipeMoveExtension(),
		listToggleExtension(),
    history(),
    indentOnInput(),
		autosaveExtension,
		fixEmptyLineBackspace,
		fixEmptyLineClick,
		listEnterKeymap,
		hangingIndentPlugin,
		nonEmptyLineDecoration,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap
    ]),
		blockGutter,
		blockBodyDecoration
  ]
});


new EditorView({
	state,
  parent: document.getElementById("editor")
});