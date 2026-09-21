/* The one setting that has no home in a menu: what you want the assistant to do differently.
 * Everything it already knows is shown below the box, so you can see what you are adding to. */
const { $, get, post } = window.cosDom;

let max = 8000;

const say = (text, tone = "") => {
  const said = $("said");
  said.textContent = text;
  said.dataset.tone = tone;
};

function count() {
  const n = $("instructions").value.trim().length;
  $("count").textContent = `${n.toLocaleString()} of ${max.toLocaleString()} characters`;
}

async function loadInstructions() {
  const r = await get("/api/instructions");
  max = r.max ?? max;
  $("instructions").value = r.text ?? "";
  $("file").textContent = r.file ?? "";
  $("default").textContent = r.default ?? "";
  count();
}

async function saveInstructions(text) {
  const r = await post("/api/instructions", { text });
  if (r.error) return say(r.error, "error");
  $("instructions").value = r.text ?? "";
  count();
  say(r.message);
}

$("save").addEventListener("click", () => saveInstructions($("instructions").value));
$("clear").addEventListener("click", () => saveInstructions(""));
$("instructions").addEventListener("input", count);
// ⌘S from inside the box, because that is what hands do in a text box.
$("instructions").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    saveInstructions($("instructions").value);
  }
});
loadInstructions().catch(() => say("The app isn't answering.", "error"));
