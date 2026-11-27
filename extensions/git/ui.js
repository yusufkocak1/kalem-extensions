import { startEditor } from "./editor.js";
import { translator } from "./i18n.js";
import { startPane } from "./pane.js";

const kalem = window.kalem;
const t = translator(kalem.language);
const app = document.getElementById("app");
document.documentElement.lang = kalem.language;

if (kalem.editor) startEditor(kalem, t, app);
else startPane(kalem, t, app);
