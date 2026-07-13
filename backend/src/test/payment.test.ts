import express from "express";

const app = express();
app.use(express.json());

app.post("/payment", async (req, res) => {
  const { idempotencyKey, provider, paymentPlan } = req.body;

  if (!idempotencyKey) {
    return res.status(400).json({ error: "Missing idempotencyKey" });
  }

  res.status(201).json({
    success: true,
    transactionId: "txn_123",
    idempotencyKey,
    provider,
    paymentPlan,
  });
});

const server = app.listen(8080, async () => {
  console.log("Test server running on port 3001");
  const paymentUrl = `http://localhost:8081/payment/checkout-session`;
  try {
    // Test 1: Successful payment
    const response1 = await fetch(paymentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: "cmq17tbf80003v5ugeifxyer1",
        userId: "cmprz5oya00006cugqjz6uwml",
        idempotencyKey: "usr_asbcs12s34ss-csssls0ssssdsssswssssassa010",
        provider: "dodo",
      }),
    });

    const data1 = await response1.json();
    console.log(
      "Test 1 - POST payment:",
      response1.status === 201 ? "✓ PASS" : "✗ FAIL",
    );
    console.log("Response:", data1);

    // Test 2: Missing idempotencyKey
    const response2 = await fetch(paymentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: "cmq17tbf80003v5ugeifxyer1",
        userId: "cmprz5oya00006cugqjz6uwml",
        provider: "dodo",
      }),
    });

    const data2 = await response2.json();
    console.log(
      "Test 2 - Missing field:",
      response2.status === 400 ? "✓ PASS" : "✗ FAIL",
    );
    console.log("Response:", data2);

    server.close();
  } catch (error) {
    console.error("Test error:", error);
    server.close();
  }
});
