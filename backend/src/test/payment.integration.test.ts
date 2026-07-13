// Client (3000) → Backend (8080/api/payments) → Payment Service (8081)

const BACKEND_URL = "http://localhost:8080";
const CLERK_TOKEN = process.env.CLERK_TOKEN || "test-token"; // Get from client login

async function testPaymentFlow() {
  console.log("=== Client to Backend Integration Test ===");
  console.log(`Client → Backend (/api/payments) → Payment Service\n`);

  try {
    console.log("📤 Client: Sending POST /api/payments to backend...");
    const response = await fetch(`${BACKEND_URL}/api/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CLERK_TOKEN}`,
      },
      body: JSON.stringify({
        idempotencyKey: "idempotency_key_" + Date.now(),
        provider: "dodo",
        paymentPlan: "STANDARD",
      }),
    });

    const status = response.status;
    const data = await response.json();

    console.log(`\n📥 Backend Response: ${status}`);
    console.log("Data:", JSON.stringify(data, null, 2));

    if (status === 200 || status === 201) {
      console.log("\n✅ SUCCESS: Payment session created");
      if (data.checkoutUrl) console.log(`Checkout: ${data.checkoutUrl}`);
      if (data.sessionId) console.log(`Session: ${data.sessionId}`);
    } else if (status === 401) {
      console.log("\n⚠️  AUTH REQUIRED");
      console.log("Pass Bearer token via Authorization header");
      console.log("Get CLERK_TOKEN from client after login");
    } else {
      console.log(`\n❌ FAILED: Status ${status}`);
    }
  } catch (error: any) {
    console.error("\n❌ ERROR:", error.message);
    console.log("\nSetup:");
    console.log("✓ Backend: npm run dev");
    console.log("✓ Payment Service: running on :8081");
    console.log("✓ CLERK_TOKEN: from client login session");
  }
}

testPaymentFlow();
