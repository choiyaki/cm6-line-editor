import { EditorView, keymap } from "https://esm.sh/@codemirror/view";
import { EditorState } from "https://esm.sh/@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands";
import { indentOnInput } from "https://esm.sh/@codemirror/language";
import { highlightActiveLine } from "https://esm.sh/@codemirror/view";
import { Decoration, ViewPlugin } from "https://esm.sh/@codemirror/view";

// --- Custom Modules ---
import {
  initUI,
  headerFocusWatcher
} from "./src/ui.js";

import {
  initAuth,
  setupNetworkListeners,
  syncExtension,
  imeWatcher,
  appendOnlyFilter,
  appendStart,
  loadFromLocal,
  isComposing
} from "./src/firebase-sync.js";

import { markdownLookPlugin } from "./src/cm-plugins/markdown-look.js";
import {
  blockHeadGutter,
  blockBodyDecoration,
  hangingIndentPlugin,
  nonEmptyLineDecoration
} from "./src/cm-plugins/block-decorations.js";
import {
  fixEmptyLineBackspace,
  listEnterKeymap,
  listToggleKeymap,
  indentKeymap,
  moveLineKeymap
} from "./src/cm-plugins/keymaps.js";
import {
  swipeIndentExtension,
  rightSideFocusedEditExtension,
  listToggleExtension
} from "./src/cm-plugins/touch-gestures.js";
import { selectionMovePopup } from "./src/cm-plugins/selection-menu.js";

import { RangeSetBuilder } from "https://esm.sh/@codemirror/state";

// --- Plugins kept in main.js temporarily ---

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

const focusedActiveLine = ViewPlugin.fromClass(
  class {
    decorations = Decoration.none;
    update(update) {
      if (update.selectionSet || update.focusChanged || update.docChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view) {
      if (!view.hasFocus) return Decoration.none;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      return Decoration.set([
        Decoration.line({ class: "cm-activeLine" }).range(line.from)
      ]);
    }
  },
  { decorations: v => v.decorations }
);

function appendLockedLines(view) {
  if (typeof appendStart !== "number") return Decoration.none;
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  let lastLockedLine = doc.lineAt(appendStart).number;
  lastLockedLine = Math.min(lastLockedLine, doc.lines);

  for (let i = 1; i <= lastLockedLine; i++) {
    const line = doc.line(i);
    builder.add(line.from, line.from, Decoration.line({ class: "cm-append-locked-line" }));
  }
  return builder.finish();
}

const appendLockedLinePlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view) {
      this.decorations = appendLockedLines(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = appendLockedLines(update.view);
      }
    }
  },
  { decorations: v => v.decorations }
);


// --- Initialize Editor ---

const state = EditorState.create({
  doc: loadFromLocal(),
  extensions: [
    EditorView.lineWrapping,
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
    selectionMovePopup,
    appendOnlyFilter(),
    appendLockedLinePlugin
  ]
});

const view = new EditorView({
  state,
  parent: document.getElementById("editor")
});

// Setup App State
initUI(view);
setupNetworkListeners(view);
initAuth(view);

import { isLocalEditing } from "./src/firebase-sync.js";

const originalDispatch = view.dispatch.bind(view);
view.dispatch = tr => {
  // Hacky way since isLocalEditing from firebase-sync is exported but needs to be flipped inside it
  // Since we don't have a setter, we just bypass it for now. This was modifying the imported binding which is read-only.
  // A better solution would be to modify the state via a method in firebase-sync.
  originalDispatch(tr);
};

window.editorView = view;
