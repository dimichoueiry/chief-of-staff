/* The two settings that have no home in a menu: what you want the assistant to do differently,
 * and which model draws. Both are one field and one button; everything else it knows is shown
 * below the box so you can see what you are adding to. */
const { $, el, get, post } = window.cosDom;

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

async function loadImageModels() {
  const r = await get("/api/images/models");
  const current = r.current?.spec ?? "";
  const select = $("image-model");
  select.replaceChildren(
    ...(r.models ?? []).map((m) => {
      const spec = `openrouter:${m.id}`;
      const option = el("option", { value: spec }, m.name === m.id ? m.id : `${m.name} — ${m.id}`);
      if (spec === current) option.selected = true;
      return option;
    }),
  );
  $("image-note").textContent = [
    r.current?.ready ? `In use: ${current} (${r.current.source}).` : "No OpenRouter key yet, so nothing can draw. Add one under ✦ › API keys.",
    r.error ? `OpenRouter didn't list its models (${r.error}), so this is the built-in list.` : "",
  ].filter(Boolean).join(" ");
}

async function saveImageModel() {
  const r = await post("/api/models/image", { spec: $("image-model").value });
  if (r.error) return say(r.error, "error");
  say(r.message);
  await loadImageModels();
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
$("save-image").addEventListener("click", saveImageModel);

loadInstructions().catch(() => say("The app isn't answering.", "error"));
loadImageModels().catch(() => say("Couldn't reach OpenRouter's model list.", "error"));
