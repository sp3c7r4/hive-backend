export function oauthResponsePage({
	title,
	message,
	status = "success",
	autoClose = true,
	payload = null,
}: {
	title: string;
	status: "success" | "error" | "warning";
	message?: string;
	autoClose?: boolean;
	payload: any;
}) {
	const colors = {
		success: {
			bg: "oklch(0.145 0 0)",
			text: "#065F46",
			icon: "✓",
			border: "#065F46",
		},
		error: {
			bg: "oklch(0.145 0 0)",
			text: "#991B1B",
			icon: "✕",
			border: "#991B1B",
		},
		warning: {
			bg: "oklch(0.145 0 0)",
			text: "#92400E",
			icon: "!",
			border: "#92400E",
		},
	};

	const theme = colors[status] || colors.success;
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(0.145 0 0);
  }
  .card {
    border-radius: 12px;
    padding: 40px;
    max-width: 420px;
    width: 90%;
    text-align: center;
  }
  .icon {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: ${theme.bg};
    border: 2px solid ${theme.border};
    color: ${theme.text};
    font-size: 24px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    animation: iconReveal 0.6s ease-out 0.4s both;
  }
  @keyframes iconReveal {
    from { opacity: 0; transform: scale(0.5) rotate(-180deg); }
    to { opacity: 1; transform: scale(1) rotate(0deg); }
  }
  h1 { font-size: 20px; color: oklch(1 0 0); margin-bottom: 8px; }
  p { font-size: 15px; color: oklch(1 0 0); line-height: 1.5; }
  .note { margin-top: 24px; font-size: 13px; color: oklch(1 0 0); }
  </style>
</head>
<body>
  <div class="card">
  <div class="icon">${theme.icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <p class="note">This window will close automatically...</p>
  </div>

  <script>
  (function() {
    ${payload ? `if (window.opener) { window.opener.postMessage(${JSON.stringify(payload)}, '*'); }` : ""}
    ${autoClose ? `setTimeout(() => { window.close(); setTimeout(() => { document.querySelector('.note').textContent = 'You can close this window now.'; }, 500); }, 2000);` : ""}
  })();
  </script>
</body>
</html>`;
}
