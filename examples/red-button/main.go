// Red Button — a shrinking, jumping button.
//
//   go run ./examples/red-button
//
// Opens a local page with a big red button. Each press shrinks it and
// teleports it somewhere else. When it gets too small to click, you win.
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
)

const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DO NOT PRESS</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      overflow: hidden;
      background: #0a0a0c;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      color: #f4f4f5;
      user-select: none;
    }
    #stage {
      position: relative;
      width: 100vw;
      height: 100vh;
    }
    #hud {
      position: fixed;
      top: 20px;
      left: 0;
      right: 0;
      text-align: center;
      pointer-events: none;
      z-index: 2;
    }
    #hud h1 {
      font-size: 13px;
      letter-spacing: 0.35em;
      text-transform: uppercase;
      color: #71717a;
      font-weight: 600;
    }
    #hud p {
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
      color: #a1a1aa;
      font-size: 14px;
    }
    #btn {
      position: absolute;
      display: grid;
      place-items: center;
      border: 0;
      cursor: pointer;
      color: #fff;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border-radius: 50%;
      background:
        radial-gradient(circle at 32% 28%, #ff7a7a 0%, #e10600 42%, #8b0000 100%);
      box-shadow:
        0 0 0 6px rgba(225, 6, 0, 0.18),
        0 18px 40px rgba(225, 6, 0, 0.35),
        inset 0 -14px 22px rgba(0, 0, 0, 0.28),
        inset 0 10px 16px rgba(255, 255, 255, 0.22);
      transition: width 160ms ease, height 160ms ease, font-size 160ms ease,
                  transform 80ms ease, left 180ms cubic-bezier(.2,.8,.2,1),
                  top 180ms cubic-bezier(.2,.8,.2,1);
      z-index: 1;
    }
    #btn:active { transform: scale(0.94); }
    #btn:focus { outline: none; }
    #btn span { pointer-events: none; text-shadow: 0 2px 8px rgba(0,0,0,0.35); }
    #win {
      display: none;
      position: fixed;
      inset: 0;
      place-items: center;
      text-align: center;
      z-index: 3;
      background: rgba(10, 10, 12, 0.72);
      backdrop-filter: blur(8px);
    }
    #win.show { display: grid; }
    #win h2 { font-size: 42px; letter-spacing: 0.08em; }
    #win p { margin: 12px 0 24px; color: #a1a1aa; }
    #again {
      border: 0;
      padding: 12px 22px;
      border-radius: 999px;
      background: #e10600;
      color: #fff;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="stage">
    <div id="hud">
      <h1>do not press</h1>
      <p id="stat">presses 0 · size 220px</p>
    </div>
    <button id="btn" type="button" aria-label="Big red button"><span>PUSH</span></button>
    <div id="win">
      <div>
        <h2>TOO SMALL</h2>
        <p id="final">you mashed it out of existence</p>
        <button id="again" type="button">again</button>
      </div>
    </div>
  </div>
  <script>
    const MIN = 18;
    const START = 220;
    const SHRINK = 0.86;

    const btn = document.getElementById("btn");
    const stat = document.getElementById("stat");
    const win = document.getElementById("win");
    const final = document.getElementById("final");
    const again = document.getElementById("again");

    let size = START;
    let presses = 0;

    function place() {
      const pad = 16;
      const maxX = Math.max(pad, window.innerWidth - size - pad);
      const maxY = Math.max(pad, window.innerHeight - size - pad);
      const x = pad + Math.random() * (maxX - pad);
      const y = pad + Math.random() * (maxY - pad);
      btn.style.left = x + "px";
      btn.style.top = y + "px";
    }

    function paint() {
      btn.style.width = size + "px";
      btn.style.height = size + "px";
      btn.style.fontSize = Math.max(8, size * 0.18) + "px";
      btn.querySelector("span").textContent = size < 70 ? "!" : "PUSH";
      stat.textContent = "presses " + presses + " · size " + Math.round(size) + "px";
    }

    function reset() {
      size = START;
      presses = 0;
      win.classList.remove("show");
      btn.style.display = "grid";
      paint();
      btn.style.left = (window.innerWidth - size) / 2 + "px";
      btn.style.top = (window.innerHeight - size) / 2 + "px";
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      presses += 1;
      size = Math.max(MIN - 1, size * SHRINK);
      if (size < MIN) {
        btn.style.display = "none";
        final.textContent = presses + " presses. it got away.";
        win.classList.add("show");
        stat.textContent = "presses " + presses + " · gone";
        return;
      }
      paint();
      place();
    });

    again.addEventListener("click", reset);
    window.addEventListener("resize", () => {
      if (size >= MIN) place();
    });

    reset();
  </script>
</body>
</html>
`

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func main() {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	url := fmt.Sprintf("http://%s/", ln.Addr().String())

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	})

	fmt.Printf("red button → %s\n", url)
	openBrowser(url)
	log.Fatal(http.Serve(ln, nil))
}
