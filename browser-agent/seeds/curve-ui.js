/** Curve Plotter home UI — turned into a source string for IndexedDB seeding. */
export function curvePlotterUi() {
  const canvas = document.getElementById("plot");
  const ctx = canvas.getContext("2d");
  const input = document.getElementById("equation");
  const btn = document.getElementById("plot-btn");

  const X_MIN = -2;
  const X_MAX = 2;
  const Y_MIN = -1;
  const Y_MAX = 4;
  const PAD = 36;
  const strokeColor = "#1a4f8b";
  const strokeWidth = 2.25;

  function xToPx(x) {
    return PAD + ((x - X_MIN) / (X_MAX - X_MIN)) * (canvas.width - 2 * PAD);
  }
  function yToPx(y) {
    return canvas.height - PAD - ((y - Y_MIN) / (Y_MAX - Y_MIN)) * (canvas.height - 2 * PAD);
  }

  function drawAxes() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let x = Math.ceil(X_MIN); x <= Math.floor(X_MAX); x++) {
      const px = xToPx(x);
      ctx.beginPath();
      ctx.moveTo(px, PAD);
      ctx.lineTo(px, canvas.height - PAD);
      ctx.stroke();
    }
    for (let y = Math.ceil(Y_MIN); y <= Math.floor(Y_MAX); y++) {
      const py = yToPx(y);
      ctx.beginPath();
      ctx.moveTo(PAD, py);
      ctx.lineTo(canvas.width - PAD, py);
      ctx.stroke();
    }

    const ox = xToPx(0);
    const oy = yToPx(0);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD, oy);
    ctx.lineTo(canvas.width - PAD, oy);
    ctx.moveTo(ox, PAD);
    ctx.lineTo(ox, canvas.height - PAD);
    ctx.stroke();

    ctx.fillStyle = "#475569";
    ctx.font = "11px IBM Plex Sans, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (let x = Math.ceil(X_MIN); x <= Math.floor(X_MAX); x++) {
      if (x === 0) continue;
      ctx.fillText(String(x), xToPx(x), oy + 14);
    }
    ctx.textAlign = "right";
    for (let y = Math.ceil(Y_MIN); y <= Math.floor(Y_MAX); y++) {
      if (y === 0) continue;
      ctx.fillText(String(y), ox - 6, yToPx(y) + 4);
    }
    ctx.textAlign = "left";
    ctx.fillText("x", canvas.width - PAD + 6, oy - 6);
    ctx.fillText("y", ox + 6, PAD - 8);
  }

  function compileExpr(src) {
    let s = String(src || "x^2").trim();
    s = s.replace(/\^/g, "**");
    s = s.replace(/\bSin\b/gi, "sin").replace(/\bCos\b/gi, "cos").replace(/\bTan\b/gi, "tan");
    s = s.replace(/\bsin\b/g, "Math.sin").replace(/\bcos\b/g, "Math.cos").replace(/\btan\b/g, "Math.tan");
    s = s.replace(/\bsqrt\b/g, "Math.sqrt").replace(/\babs\b/g, "Math.abs").replace(/\bpi\b/gi, "Math.PI");
    s = s.replace(/(\d)\s*x\b/g, "$1*x");
    return new Function("x", "return (" + s + ");");
  }

  function plot() {
    drawAxes();
    let fn;
    try {
      fn = compileExpr(input.value);
    } catch (err) {
      console.warn("Bad equation", err);
      return;
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.beginPath();
    const n = 320;
    let started = false;
    for (let i = 0; i <= n; i++) {
      const x = X_MIN + (i / n) * (X_MAX - X_MIN);
      let y;
      try {
        y = fn(x);
      } catch {
        started = false;
        continue;
      }
      if (!Number.isFinite(y)) {
        started = false;
        continue;
      }
      const px = xToPx(x);
      const py = yToPx(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  btn.addEventListener("click", plot);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") plot();
  });
  plot();
}

export const CURVE_UI_SOURCE = "(" + curvePlotterUi.toString() + ")();";
