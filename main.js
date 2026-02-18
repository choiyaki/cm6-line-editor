import {
  EditorView,
  ViewPlugin,
  gutter,
  GutterMarker,
  keymap,
	Decoration,
	WidgetType,
	highlightActiveLine,
  highlightActiveLineGutter
} from "https://esm.sh/@codemirror/view";

import {
  EditorState,
  StateEffect,
	EditorSelection
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

import {
  db,
	auth,
  provider
} from "./firebase.js";

import {
  doc,
  setDoc,
  onSnapshot,
  getDoc,
  serverTimestamp,
	getDocFromServer
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  signInWithRedirect,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

try {
  await setPersistence(auth, browserLocalPersistence);
} catch (e) {
  console.warn("setPersistence failed", e);
}

// ===== append モード管理 =====
let appendStart = null;     // number | null
let isOfflineMode = false; // 表示用

const appendRestrictExtension =
  EditorState.transactionFilter.of(tr => {
    if (appendStart == null) return tr; // オンライン時は自由

    // appendStart より前に変更が及んだら拒否
    for (const r of tr.changes.iterRanges()) {
      if (r.from < appendStart) {
        return []; // この操作を無効化
      }
    }
    return tr;
  });

	
const appendReadonlyDecoration = ViewPlugin.fromClass(
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
      if (appendStart == null) return Decoration.none;

      return Decoration.set([
        Decoration.mark({
          class: "cm-append-readonly"
        }).range(0, appendStart)
      ]);
    }
  },
  {
    decorations: v => v.decorations
  }
);


function buildExportText(doc) {
  // CodeMirror の doc → 文字列
  const fullText = doc.toString();

  return removeMarkedBlocks(fullText);
}

function removeMarkedBlocks(text) {
  // 空行（1行以上）でブロック分割
  const blocks = text.split(/\n\s*\n/);

  const cleanedBlocks = blocks.filter(block => {
    const firstLine = block.split("\n")[0] ?? "";

    // 先頭行に 📝 or 📓 があれば除外
    return !(
      firstLine.includes("📝") ||
      firstLine.includes("📓")
    );
  });

  // 空行2行で再結合（Markdownとして自然）
  return cleanedBlocks.join("\n\n");
}

function readAppendTextFromURL() {
  const params = new URLSearchParams(location.search);
  return params.get("text");
}

let pendingAppendText = readAppendTextFromURL();
let appendApplied = false;

let isInitializing = true; // ★ 追加

function onInitialFirestoreLoaded(editor) {
  if (!pendingAppendText || appendApplied) return;
  applyAppend(editor, pendingAppendText);

  appendApplied = true;
  pendingAppendText = null;

}

function applyAppend(editor, text) {
  const doc = editor.state.doc;
  const content = doc.toString();

  let insertText = text;

  // 末尾が空行でなければ、必ず空行を1行あける
  if (!content.endsWith("\n\n")) {
    insertText = "\n\n" + text;
  }

  editor.dispatch({
    changes: {
      from: doc.length,
      insert: insertText
    }
  });
}

const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const menuUser = document.getElementById("menu-user");
/*
loginBtn.addEventListener("click", async () => {
  await signInWithRedirect(auth, provider);
});*/
loginBtn.addEventListener("click", async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    console.log("login success", result.user);
  } catch (e) {
    console.error(e);
  }
});

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
  menuPanel.hidden = true;
});



onAuthStateChanged(auth, async user => {
  if (user) {
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");

    docRef = getUserDocRef(user.uid);

    const snap = await getDoc(docRef);

    if (!snap.exists()) {
      // ★ local の内容を引き継ぐ
      await setDoc(docRef, {
        title: loadTitleLocal(),
        text: loadFromLocal(),
        createdAt: serverTimestamp()
      });
    }

    startFirestoreSync(view, docRef);
  } else {
    stopFirestoreSync();
    docRef = null;
  }
});

let unsubscribe = null;

function startFirestoreSync(view, ref) {
  if (!view) return;
  stopFirestoreSync();

  isInitializing = true;

  let firstSnapshot = true;

  unsubscribe = onSnapshot(ref, snap => {
    if (!snap.exists()) return;

    const data = snap.data();
    const remoteText = data.text ?? "";
    const remoteTitle = data.title ?? "無題";

    /* ==================================================
     * 初回 snapshot（起動時）
     * ================================================== */
    if (firstSnapshot) {
      firstSnapshot = false;

      if (snap.metadata.fromCache) {
        // ===== オフライン起動 =====
				alert("off")
        const cached = loadFromLocal() ?? "";

        appendStart = cached.length + 2; // "\n\n" 分
        isOfflineMode = true;

        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: cached + "\n\n"
          }
        });
      } else {
        // ===== オンライン起動 =====
				alert("on")
        appendStart = null;
        isOfflineMode = false;

        isApplyingRemote = true;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: remoteText
          }
        });
        isApplyingRemote = false;
      }

      // title 反映
      applyTitleFromRemote(remoteTitle);

      isInitializing = false;
      onInitialFirestoreLoaded(view);
      return;
    }

    /* ==================================================
     * オフライン → オンライン復帰
     * ================================================== */
    if (
      isOfflineMode &&
      appendStart != null &&
      !snap.metadata.fromCache
    ) {
      const current = view.state.doc.toString();
      const appendText = current.slice(appendStart);

      appendStart = null;
      isOfflineMode = false;

      isApplyingRemote = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: remoteText + appendText
        }
      });
      isApplyingRemote = false;

      applyTitleFromRemote(remoteTitle);
      return;
    }

    /* ==================================================
     * 通常のリアルタイム同期
     * ================================================== */
    if (isApplyingRemote) return;
    if (view.hasFocus || isComposing || isLocalEditing) return;

    const current = view.state.doc.toString();
    if (remoteText !== current) {
      isApplyingRemote = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: remoteText
        }
      });
      isApplyingRemote = false;
    }

    if (titleInput.value !== remoteTitle) {
      applyTitleFromRemote(remoteTitle);
    }
  });
}

function applyTitleFromRemote(title) {
  const normalized = title?.trim() || "無題";

  // input に反映
  titleInput.value = normalized;

  // localStorage にも同期
  localStorage.setItem(TITLE_KEY, normalized);
}

function stopFirestoreSync() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}


const menuBtn = document.getElementById("menu-btn");
const menuPanel = document.getElementById("menu-panel");

menuBtn.addEventListener("click", () => {
  menuPanel.hidden = !menuPanel.hidden;
});

// 外側クリックで閉じる（かなり大事）
document.addEventListener("click", (e) => {
  if (
    !menuPanel.contains(e.target) &&
    e.target !== menuBtn
  ) {
    menuPanel.hidden = true;
  }
});




function isBlockSeparatorLine(text) {
  if (!text) return true;              // 完全空行
  if (text.trim() === "") return true; // 空白だけの行
  if (/^#+\s/.test(text)) return true; // 見出し行（#）
  return false;
}

let docRef = null;

function getUserDocRef(uid) {
  return doc(db, "users", uid, "memos", "main");
}


/*
function startFullSync(view) {
  onSnapshot(docRef, snap => {
    if (!snap.exists()) return;
    if (isApplyingRemote) return;

    // ★ 追加条件（核心）
    if (isComposing) return;
    if (isLocalEditing) return;
    if (view.hasFocus) return; // ★ フォーカス中は触らない

    const { text } = snap.data();
    if (typeof text !== "string") return;

    const current = view.state.doc.toString();
    if (text === current) return;

    isApplyingRemote = true;

    // ★ selection を維持する
    const sel = view.state.selection.main;

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: text
      },
      selection: {
        anchor: Math.min(sel.anchor, text.length),
        head: Math.min(sel.head, text.length)
      }
    });

    isApplyingRemote = false;
  });
}

*/

const syncExtension = EditorView.updateListener.of(update => {
  if (!update.docChanged) return;
  if (isInitializing) return;
  if (isApplyingRemote) return;
  if (isComposing) return;
  scheduleSave(update.state);
});


const markdownLookPlugin = ViewPlugin.fromClass(
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

      return Decoration.set(decos);
    }
  },
  {
    decorations: v => v.decorations
  }
);

function getIndentLevel(text) {
  const m = text.match(/^(\s*)/);
  return m ? Math.floor(m[1].length / 2) : 0;
}

/* --- 正規表現 --- */
const localLinkRE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const imageRE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/;

/* --- 画像ウィジェット --- */
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

const markdownLinkHandler = EditorView.domEventHandlers({
  click(event) {
    const el = event.target.closest(".cm-md-link");
    if (!el) return false;

    const url = el.getAttribute("data-url");
    if (url) {
      window.open(url, "_blank");
      return true;
    }
  }
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
	if (content.trim() === "") {
	  return;
	}

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
	  },
	  selection: {
	    anchor: line.from + next.length
	  }
	});
}





function swipeIndentExtension() {
  return EditorView.domEventHandlers({
    touchstart(event, view) {
			if (!view.hasFocus) return;
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




function isBlockStartSafe(state, lineDesc) {
  if (!lineDesc || lineDesc.from == null) return false;

  const line = state.doc.lineAt(lineDesc.from);

  // ★ 自身が境界行ならブロック開始ではない
  if (isBlockSeparatorLine(line.text)) return false;

  // 先頭行は常にブロック開始
  if (line.number === 1) return true;

  const prev = state.doc.line(line.number - 1);

  // ★ 直前が境界行ならブロック開始
  return isBlockSeparatorLine(prev.text);
}

class BlockHeadButtonMarker extends GutterMarker {
  constructor(view, from) {
    super();
    this.view = view;
    this.from = from; // ★ line.number ではなく from
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-block-head-button";
    el.textContent = "●";

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const line = this.view.state.doc.lineAt(this.from);
      const lineNumber = line.number;

      showBlockMenu({
        view: this.view,
        lineNumber,
        anchorEl: el
      });
    });

    return el;
  }
}

const blockHeadGutter = gutter({
  class: "cm-block-head-gutter",

  lineMarker(view, line) {
    // ブロック先頭以外は描画しない
    if (!isBlockStartSafe(view.state, { from: line.from })) {
      return null;
    }

    return new BlockHeadButtonMarker(
      view,
      line.from
    );
  }
});


function getBlockText(state, startLineNumber) {
  const doc = state.doc;
  const lines = [];

  let lineNo = startLineNumber;
  const maxLine = doc.lines;

  while (lineNo <= maxLine) {
    const line = doc.line(lineNo);
    const text = line.text;

    // 完全な空行でブロック終了
    if (isBlockSeparatorLine(text)) break;

    // 次のブロック開始で止めたいなら
    if (
      lineNo !== startLineNumber &&
      isBlockStartSafe(state, { from: line.from })
    ) {
      break;
    }

    lines.push(text);
    lineNo++;
  }

  return lines;
}

function getCurrentTitle() {
  const TITLE_KEY = "cm6-title";

  const saved = localStorage.getItem(TITLE_KEY);
  if (saved && saved.trim() !== "") {
    return saved.trim();
  }

  // フォールバック（未保存・空のとき）
  return (saved && saved.trim() !== "") ? saved.trim() : "無題";
}

function blockUrlBuilders(blockLines,action) {
	const title = getCurrentTitle();
	if(action === "scrapbox") {
    const date = encodeURIComponent(`${title}日誌`);
	  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
		
		const body = encodeURIComponent(bodyText);
	  return `sbporter://scrapbox.io/choiyaki/${date}?body=${body}`;
  } else if(action === "choidiary"){
	  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
		const body = encodeURIComponent(bodyText);
	  return `touch-https://scrapbox.io/choidiary/${title}?body=${body}`;
  }else if(action === "SaveLog"){
	  const bodyText = blockLines.join("\n").replace(/  /g," ").replace(/\- /g," ");
		const body = encodeURIComponent(bodyText);
	  return `shortcuts://run-shortcut?name=AddObsidian&input=${body}`;
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
		console.log(lineNumber)
	
	  const blockLines = getBlockText(view.state, lineNumber);
		if (!blockLines || blockLines.length === 0) {
		  console.warn("ブロックテキスト取得失敗", lineNumber);
		  return;
		}
	
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

function rightSideFocusedEditExtension() {
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

      // ★ 右側25%のみ編集対象
      if (localX < rect.width * 0.75) return;

      isRightSide = true;
      startX = t.clientX;
      startY = t.clientY;
      hasHandledVertical = false;

      // ★ 右側編集エリアでは最初からスクロール権限を奪う
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

      // 横が強い → 何もしない（インデント側に任せる）
      if (absX > absY) return;

      // 縦が弱い → 無視
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

      // ★ 編集中は常にスクロール禁止
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

function indentCurrentLine(view) {
  const { state } = view;
  const sel = state.selection.main;
	if (!sel.empty) return;
  const pos = sel.head;
  const line = state.doc.lineAt(pos);

  const column = pos - line.from; // ★ 列位置を保存
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

function outdentCurrentLine(view) {
  const { state } = view;
  const sel = state.selection.main;
	if (!sel.empty) return;
  const pos = sel.head;
  const line = state.doc.lineAt(pos);

  const column = pos - line.from; // ★ 列位置を保存
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



// ===== Header auto hide controller =====
const headerEl = document.getElementById("app-header");

let editorFocused = false;
let keyboardVisible = false;

// --- キーボード検知（iOS / Android 共通で安定） ---
if (window.visualViewport) {
  const baseHeight = window.visualViewport.height;

  visualViewport.addEventListener("resize", () => {
		  const diff = baseHeight - visualViewport.height;
		
		  // ★ ソフトウェアキーボード判定
		  keyboardVisible = diff > 120;
    updateHeaderVisibility();
  });
}

// --- 表示制御 ---
function updateHeaderVisibility() {
  if (editorFocused && keyboardVisible) {
    headerEl.classList.add("is-hidden");
    document.body.classList.add("header-hidden");   // ★ 追加
  } else {
    headerEl.classList.remove("is-hidden");
    document.body.classList.remove("header-hidden"); // ★ 追加
  }
}

const headerFocusWatcher = EditorView.domEventHandlers({
  focus() {
    editorFocused = true;
    updateHeaderVisibility();
  },
  blur() {
    editorFocused = false;
    updateHeaderVisibility();
  }
});


function exportDocument(view) {
  if (!view) return;

  const title =
    localStorage.getItem("cm6-title")?.trim() || "無題";

  // ★ ブロック除外済み本文
  const filteredBody = buildExportText(view.state.doc)
    .replace(/  /g, " ")
    .replace(/\- /g, " ");

  const bodyText = title + "\n" + filteredBody;

  if (!filteredBody.trim()) {
    alert("本文が空です");
    return;
  }

  const url =
    `shortcuts://run-shortcut?name=Choiyakiをmd保存&input=${encodeURIComponent(bodyText)}`;

  window.location.href = url;
}

// ===== Export button handler =====
const exportBtn = document.querySelector(".header-btn.right");

if (exportBtn) {
  exportBtn.addEventListener("click", () => {
    exportDocument(window.editorView);
  });
} else {
  console.warn("export button not found");
}

/*
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
*/

let isApplyingRemote = false; // Firestore反映中フラグ
let isComposing = false;      // IME入力中
let isLocalEditing = false;
let saveTimer = null;         // debounce用



function scheduleSave(state) {
  if (isInitializing) return;
  if (isApplyingRemote) return;
  if (isComposing) return;
	if (appendStart != null) return;
  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    // ★ ログインしていない → localStorage
    if (!docRef) {
      saveToLocal(state);
      console.log("💾 saved to local");
      return;
    }

    // ★ ログインしている → Firestore
    setDoc(
      docRef,
      {
        title: getCurrentTitle(),
        text: state.doc.toString(),
        updatedAt: serverTimestamp()
      },
      { merge: true }
    )
      .then(() => console.log("🔥 saved to firestore"))
      .catch(e => console.error("❌ save failed", e));
  }, 500);
}

function saveTitle() {
  const value = titleInput.value.trim() || "無題";

  // ★ 常に local に保存（ログアウト対策）
  saveTitleLocal(value);

  // ★ ログイン中のみ Firestore
  if (!docRef || isInitializing) return;

  setDoc(
    docRef,
    {
      title: value,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

const imeWatcher = EditorView.domEventHandlers({
  compositionstart() {
    isComposing = true;
  },

  compositionend(event, view) {
    isComposing = false;

    // ★ CM5と同じ：確定した瞬間に保存
    scheduleSave(view.state);
  }
});








const titleInput = document.querySelector(".header-title");

const TITLE_KEY = "cm6-title";

/* ===== load ===== */
const savedTitle = localStorage.getItem(TITLE_KEY);
if (savedTitle !== null) {
  titleInput.value = savedTitle ?? "";
}

/* ===== save ===== 
function saveTitle() {
  const value = titleInput.value.trim();
  if (value === "") {
    localStorage.removeItem(TITLE_KEY);
  } else {
    localStorage.setItem(TITLE_KEY, value);
  }
}*/

titleInput.addEventListener("input", saveTitle);
titleInput.addEventListener("blur", saveTitle);

let composing = false;

titleInput.addEventListener("compositionstart", () => {
  composing = true;
});

titleInput.addEventListener("compositionend", () => {
  composing = false;
  saveTitle();
});

titleInput.addEventListener("input", () => {
  if (!composing) saveTitle();
});


const focusedActiveLine = ViewPlugin.fromClass(
  class {
    decorations = Decoration.none;

    update(update) {
      if (
        update.selectionSet ||
        update.focusChanged ||
        update.docChanged
      ) {
        this.decorations = this.build(update.view);
      }
    }

    build(view) {
      // ★ フォーカスがなければ一切描画しない
      if (!view.hasFocus) {
        return Decoration.none;
      }

      const line = view.state.doc.lineAt(
        view.state.selection.main.head
      );

      return Decoration.set([
        Decoration.line({
          class: "cm-activeLine"
        }).range(line.from)
      ]);
    }
  },
  {
    decorations: v => v.decorations
  }
);

function buildInsertText(docText, insertText) {
  if (!docText || docText.length === 0) {
    return insertText;
  }

  // 末尾の改行を整理（0 or 1個に）
  const trimmed = docText.replace(/\n+$/, "");

  return trimmed + "\n\n" + insertText;
}


function toggleListByKeyboard(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return true;

  const line = state.doc.lineAt(sel.head);
  const text = line.text;

  const match = text.match(/^(\s*)(- )(\[(?: |x)\] )?(.*)$/);

  let next;

  if (!match) {
    // 何もなし → リスト
    next = `- ${text}`;
  } else {
    const indent = match[1];
    const checkbox = match[3];
    const content = match[4];

    if (!checkbox) {
      // リスト → チェック
      next = `${indent}- [ ] ${content}`;
    } else if (checkbox === "[ ] ") {
      // チェック → 完了
      next = `${indent}- [x] ${content}`;
    } else {
      // 完了 → 解除
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

const listToggleKeymap = keymap.of([
  {
    key: "Mod-Enter",
    run: toggleListByKeyboard
  }
]);

const indentKeymap = keymap.of([
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

const moveLineKeymap = keymap.of([
  {
    key: "Alt-ArrowUp",
    run: moveLineUp
  },
  {
    key: "Alt-ArrowDown",
    run: moveLineDown
  }
]);

const LOCAL_TEXT_KEY = "cm6-doc-text";
const LOCAL_TITLE_KEY = "cm6-doc-title";

function saveToLocal(state) {
  localStorage.setItem(
    LOCAL_TEXT_KEY,
    state.doc.toString()
  );
}

function loadFromLocal() {
  return localStorage.getItem(LOCAL_TEXT_KEY) ?? "";
}

function saveTitleLocal(value) {
  localStorage.setItem(LOCAL_TITLE_KEY, value);
}

function loadTitleLocal() {
  return localStorage.getItem(LOCAL_TITLE_KEY) ?? "";
}

titleInput.value = loadTitleLocal();


function moveSelectionByLines(view, dir) {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return;

  let doc = state.doc;

  const s = sel.from;
  const e = sel.to;

  // ===== ① まず末尾改行を保証 =====
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

    // ★ state / doc を必ず取り直す
    doc = view.state.doc;
  }

  let fromLine = doc.lineAt(s);
  let toLine = doc.lineAt(e);

  // ===== 上移動 =====
  if (dir < 0) {
    if (fromLine.number === 1) return;

    const upperLine = doc.line(fromLine.number - 1);

    const upperText = doc.sliceString(
      upperLine.from,
      upperLine.to + 1
    );

    const blockText = doc.sliceString(
      fromLine.from,
      toLine.to + 1
    );

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

  // ===== 下移動 =====
  if (dir > 0) {
    if (toLine.number === doc.lines) return;

    const lowerLine = doc.line(toLine.number + 1);

    const blockText = doc.sliceString(
      fromLine.from,
      toLine.to + 1
    );

    const lowerText = doc.sliceString(
      lowerLine.from,
      lowerLine.to + 1
    );

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

const selectionMovePopup = ViewPlugin.fromClass(
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

      // ===== 完全ガード =====
      if (
        sel.empty ||                 // 選択なし
        !this.view.hasFocus ||       // フォーカスなし
        isComposing                  // IME変換中
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
        this.dom.style.top =
          `${coords.top - editorRect.top - 44}px`;
        this.dom.style.left =
          `${coords.left - editorRect.left}px`;
      });
    }

    destroy() {
      this.dom.remove();
    }
  }
);

function toggleCheckboxSelection(view) {
  forEachSelectedLineWithDelta(view, text => {
    // チェック未完了
    if (/^\s*- \[ \]\s+/.test(text)) {
      return text.replace(
        /^(\s*)- \[ \]\s+/,
        "$1- [x] "
      );
    }

    // チェック完了
    if (/^\s*- \[x\]\s+/.test(text)) {
      return text.replace(
        /^(\s*)- \[x\]\s+/,
        "$1- "
      );
    }

    // 通常リスト
    if (/^\s*- /.test(text)) {
      return text.replace(
        /^(\s*)- /,
        "$1- [ ] "
      );
    }

    // リストでない行は何もしない
    return null;
  });
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

    // selection.from より前なら from / to 両方影響
    if (line.from < sel.from) {
      deltaFrom += diff;
      deltaTo += diff;
    }
    // selection 内なら to のみ影響
    else if (line.from < sel.to) {
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

function indentSelection(view) {
  forEachSelectedLineWithDelta(view, text => {
    const p = parseLine(text);

    // ★ まだリストでない → リスト化のみ（indent 0）
    if (!p.isList) {
      return buildLine({
        indent: 0,
        isList: true,
        content: p.content
      });
    }

    // ★ すでにリスト → インデントを1つ増やす
    return buildLine({
      indent: p.indent + 1,
      isList: true,
      content: p.content
    });
  });
}

function outdentSelection(view) {
  forEachSelectedLineWithDelta(view, text => {
    const p = parseLine(text);
    if (!p.isList) return null;

    if (p.indent > 0) {
      return buildLine({
        indent: p.indent - 1,
        isList: true,
        content: p.content
      });
    }

    // indent = 0 → リスト解除
    return p.content;
  });
}



const state = EditorState.create({
  doc: loadFromLocal(),
  extensions: [
		EditorView.lineWrapping,
		appendRestrictExtension,
  	appendReadonlyDecoration,
		headerFocusWatcher,
		imeWatcher,
		syncExtension,
		listToggleKeymap,
		indentKeymap,
		moveLineKeymap,
		focusedActiveLine,
		swipeIndentExtension(),
		rightSideFocusedEditExtension(),
		listToggleExtension(),
    history(),
    indentOnInput(),
		fixEmptyLineBackspace,
		listEnterKeymap,
		hangingIndentPlugin,
		nonEmptyLineDecoration,
		markdownLookPlugin,
		markdownLinkHandler,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap
    ]),
		blockHeadGutter,
		blockBodyDecoration,
		selectionMovePopup
  ]
});


const view = new EditorView({
  state,
  parent: document.getElementById("editor")
});

isInitializing = false;

const originalDispatch = view.dispatch.bind(view);

view.dispatch = tr => {
  isLocalEditing = true;
  originalDispatch(tr);
  isLocalEditing = false;
};

// ★ 追加：エクスポート用に保持
window.editorView = view;