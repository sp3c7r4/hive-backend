import { config } from "@/config";

export function paymentSuccessPage(amount: string) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0A0A0B;
    }
    .card {
      max-width: 400px;
      width: 90%;
      text-align: center;
      padding: 48px 36px;
      animation: cardIn 0.5s ease-out both;
    }
    @keyframes cardIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .icon-ring {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: rgba(219, 29, 106, 0.12);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      animation: iconPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.3s both;
    }
    @keyframes iconPop {
      from { opacity: 0; transform: scale(0.4); }
      to { opacity: 1; transform: scale(1); }
    }
    h1 { font-size: 19px; font-weight: 600; color: #ECECEF; margin-bottom: 8px; letter-spacing: -0.01em; }
    .amount { font-size: 28px; font-weight: 600; color: #DB1D6A; margin: 16px 0 4px; letter-spacing: -0.02em; }
    .label { font-size: 13px; color: #55555A; }
    .divider { width: 32px; height: 1px; background: rgba(255, 255, 255, 0.08); margin: 24px auto; }
    .note { font-size: 13px; color: #55555A; transition: color 0.3s ease; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-ring">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DB1D6A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
    </div>
    <h1>Payment successful</h1>
    <p class="amount">${amount}</p>
    <p class="label">Amount paid</p>
    <div class="divider"></div>
    <p class="note">Redirecting you back shortly…</p>
  </div>
  <script>
  (function() {
    setTimeout(() => {
      window.close();
      setTimeout(() => {
        document.querySelector('.note').textContent = 'You can close this window.';
        document.querySelector('.note').style.color = '#8B8B8E';
      }, 500);
    }, 2500);
  })();
  </script>
</body>
</html>`;
}

export function paymentCancelledPage() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Cancelled</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0A0A0B;
    }
    .card {
      max-width: 400px;
      width: 90%;
      text-align: center;
      padding: 48px 36px;
      animation: cardIn 0.5s ease-out both;
    }
    @keyframes cardIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .icon-ring {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      animation: iconPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.3s both;
    }
    @keyframes iconPop {
      from { opacity: 0; transform: scale(0.4); }
      to { opacity: 1; transform: scale(1); }
    }
    h1 { font-size: 19px; font-weight: 600; color: #ECECEF; margin-bottom: 8px; letter-spacing: -0.01em; }
    .message { font-size: 14px; color: #55555A; line-height: 1.6; }
    .divider { width: 32px; height: 1px; background: rgba(255, 255, 255, 0.08); margin: 24px auto; }
    .note { font-size: 13px; color: #55555A; transition: color 0.3s ease; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-ring">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#55555A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
    </div>
    <h1>Payment cancelled</h1>
    <p class="message">No charges were made to your account.</p>
    <div class="divider"></div>
    <p class="note">Redirecting you back shortly…</p>
  </div>
  <script>
  (function() {
    setTimeout(() => {
      window.close();
      setTimeout(() => {
        document.querySelector('.note').textContent = 'You can close this window.';
        document.querySelector('.note').style.color = '#8B8B8E';
      }, 500);
    }, 2500);
  })();
  </script>
</body>
</html>`;
}

export function generateCallbackUrl(amount: number) {
	const base = config.getEnvUrl();
	return `${base}/api/v1/payment/callback?amount=${amount}`;
}

export function generateCancelUrl() {
	const base = config.getEnvUrl();
	return `${base}/api/v1/payment/cancel`;
}
