import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.env.VNEXT_STORYBOARD_E2E_ORIGIN;
const token = process.env.VNEXT_STORYBOARD_E2E_TOKEN;
const projectId = process.env.VNEXT_STORYBOARD_E2E_PROJECT_ID;
const confirmationId = process.env.VNEXT_STORYBOARD_E2E_CONFIRMATION_ID;
if (!origin || !token || !projectId || !confirmationId) throw new Error("VNEXT_STORYBOARD_E2E_ORIGIN, TOKEN, PROJECT_ID, and CONFIRMATION_ID are required");

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}/api/vnext${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body.data ?? body;
}

const initialKey = `storyboard-e2e-${randomUUID()}`;
const generated = await api(`/projects/${projectId}/storyboard`, { method: "POST", body: JSON.stringify({ confirmation_id: confirmationId, client_idempotency_key: initialKey, paid_confirmation: true }) });
assert.equal(generated.outcome, "created");
assert.ok(generated.board.cells.length > 0);
const loaded = await api(`/projects/${projectId}/storyboard?confirmation_id=${confirmationId}`);
assert.equal(loaded.board.id, generated.board.id);
const target = loaded.board.cells[0]; const unchanged = loaded.board.cells[1];
const redraw = await api(`/projects/${projectId}/storyboard/cells/${target.id}/redraw`, { method: "POST", body: JSON.stringify({ confirmation_id: confirmationId, prompt: `${target.version.prompt} redraw`, client_idempotency_key: `redraw-${randomUUID()}`, paid_confirmation: true }) });
assert.equal(redraw.board.base_board_id, loaded.board.id);
assert.equal(redraw.board.cells[0].id, target.id); assert.equal(redraw.board.cells[0].version.version, target.version.version + 1);
if (unchanged) { const after = redraw.board.cells.find((cell: { id: string }) => cell.id === unchanged.id); assert.equal(after.version.id, unchanged.version.id); assert.equal(after.version.media_sha256, unchanged.version.media_sha256); }
console.log(`storyboard e2e passed: board ${redraw.board.id} v${redraw.board.version}`);
