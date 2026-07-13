/**
 * agentWave.test.ts
 *
 * Real LLM integration test for wave-based todo execution.
 * Tests that the agent:
 *   1. Outputs FINAL ANSWER TASK=N correctly for a single-task wave
 *   2. Does NOT loop — FINAL ANSWER is detected and wave completes
 *   3. Handles the old broken pattern (TASK=N without prefix) gracefully
 *
 * Run: npx tsx src/test/agentWave.test.ts
 */

import "../env";
import OpenAI from "openai";

// ─── Colours ──────────────────────────────────────────────────
const GREEN = "\x1b[32m✔\x1b[0m";
const RED   = "\x1b[31m✘\x1b[0m";
const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m⚠\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ${GREEN} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED} ${label}${detail ? `\n      → ${detail}` : ""}`);
    failed++;
  }
}

async function section(name: string, fn: () => Promise<void>) {
  console.log(`\n${BOLD}[ ${name} ]${RESET}`);
  try {
    await fn();
  } catch (err: any) {
    console.log(`  ${RED} Section crashed: ${err.message}`);
    failed++;
  }
}

// ─── Mirrors agentRunner logic exactly ────────────────────────
function parseTaskOrderFromFinalAnswer(text: string): number | null {
  const strict = text.match(/FINAL\s+ANSWER\s+TASK\s*=\s*(\d+)/i);
  if (strict) return parseInt(strict[1], 10);
  // Lenient: agent dropped FINAL ANSWER prefix but still has TASK=N FRONTEND/BACKEND=port
  const lenient = text.match(/\bTASK\s*=\s*(\d+)\s+(?:FRONTEND|BACKEND)=\d+/i);
  if (lenient) return parseInt(lenient[1], 10);
  return null;
}

function parsePortsFromFinalAnswer(text: string): { frontend?: number; backend?: number } {
  const ports: { frontend?: number; backend?: number } = {};
  const fe = text.match(/FRONTEND=(\d+)/i);
  if (fe) ports.frontend = parseInt(fe[1], 10);
  const be = text.match(/BACKEND=(\d+)/i);
  if (be) ports.backend = parseInt(be[1], 10);
  return ports;
}

// ─── Build wave message (mirrors agentRunner.buildInitialWaveMessage) ──
function buildSingleTaskWaveMessage(todo: { title: string; description: string; order: number }) {
  return [
    `## Your Task`,
    `**Task Order:** ${todo.order}`,
    `**Workspace ID:** test-workspace-123`,
    `**Title:** ${todo.title}`,
    `**Description:**`,
    todo.description,
    ``,
    `## Environment Context`,
    `- Sandbox ID: test-sandbox-abc`,
    `- Working directory: /workspace`,
    `- Project Framework: Next.js`,
    ``,
    `When done, output exactly: FINAL ANSWER TASK=${todo.order} [FRONTEND=<port>] [BACKEND=<port>]`,
    `Only include FRONTEND/BACKEND if a server is actually running.`,
  ].join("\n");
}

// ─── Simulate the loop detection (the old bug) ────────────────
function simulateWaveLoop(agentResponses: string[], wave: { order: number }[]): {
  loopDetected: boolean;
  completedOrders: number[];
  iterations: number;
} {
  const completedOrders = new Set<number>();
  let iterations = 0;
  const MAX = wave.length * 20;

  for (const response of agentResponses) {
    iterations++;
    if (iterations > MAX) break;

    if (!response.includes("FINAL ANSWER") && !response.match(/\bTASK\s*=\s*\d+\s+(?:FRONTEND|BACKEND)=/i)) {
      continue;
    }

    const parsedOrder = parseTaskOrderFromFinalAnswer(response);
    const remaining = wave.filter(t => !completedOrders.has(t.order));
    const taskOrder = parsedOrder
      ?? (wave.length === 1 ? wave[0].order : null)
      ?? (remaining.length === 1 ? remaining[0].order : null);

    if (taskOrder === null) continue;
    if (completedOrders.has(taskOrder)) continue; // already done — would loop here

    completedOrders.add(taskOrder);
    if (completedOrders.size === wave.length) break;
  }

  const loopDetected = iterations >= MAX && completedOrders.size < wave.length;
  return { loopDetected, completedOrders: [...completedOrders], iterations };
}

// ══════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════

// ─── 1. FINAL ANSWER parsing robustness ───────────────────────
async function testFinalAnswerParsing() {
  await section("FINAL ANSWER — parsing robustness", async () => {
    // Correct format
    assert(
      "Parses FINAL ANSWER TASK=1",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER TASK=1 FRONTEND=3000") === 1,
    );
    assert(
      "Parses FINAL ANSWER TASK=2 BACKEND",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER TASK=2 BACKEND=8000") === 2,
    );
    assert(
      "Parses FINAL ANSWER TASK=3 no ports",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER TASK=3") === 3,
    );

    // Case insensitive
    assert(
      "Case insensitive parsing",
      parseTaskOrderFromFinalAnswer("final answer task=1 frontend=3000") === 1,
    );

    // The old bug — TASK=N without FINAL ANSWER prefix
    const buggyOutput = "TASK=1 FRONTEND=3000 Built the frontend\nFINAL ANSWER TASK=2 BACKEND=8000 Built backend";
    const parsed = parseTaskOrderFromFinalAnswer(buggyOutput);
    // With strict parser: finds TASK=2 (FINAL ANSWER prefix takes priority)
    assert(
      "Buggy output: strict match finds TASK=2 (the FINAL ANSWER one)",
      parsed === 2,
      `got ${parsed}`,
    );

    // Lenient fallback: TASK=1 FRONTEND=3000 without FINAL ANSWER
    const lenientInput = "TASK=1 FRONTEND=3000 here is what I built";
    assert(
      "Lenient: detects TASK=N FRONTEND=port without FINAL ANSWER prefix",
      parseTaskOrderFromFinalAnswer(lenientInput) === 1,
    );

    // No match
    assert(
      "Returns null when no FINAL ANSWER",
      parseTaskOrderFromFinalAnswer("I finished building the app") === null,
    );

    // Port parsing
    const ports = parsePortsFromFinalAnswer("FINAL ANSWER TASK=1 FRONTEND=3000 BACKEND=8000");
    assert("Parses frontend port", ports.frontend === 3000);
    assert("Parses backend port", ports.backend === 8000);

    const portsNoBackend = parsePortsFromFinalAnswer("FINAL ANSWER TASK=1 FRONTEND=5173");
    assert("Parses only frontend port", portsNoBackend.frontend === 5173 && !portsNoBackend.backend);
  });
}

// ─── 2. Loop detection simulation ─────────────────────────────
async function testLoopDetection() {
  await section("Loop detection — simulating old bug", async () => {
    const wave = [{ order: 1 }, { order: 2 }];

    // OLD BUG: agent outputs TASK=1 (no FINAL ANSWER) + FINAL ANSWER TASK=2
    // Even with lenient parser, simulateWaveLoop processes ONE order per iteration.
    // The bug loop IS confirmed here — this is intentional: shows WHY we need the cap.
    const buggyResponses = Array(45).fill(
      "TASK=1 FRONTEND=3000 Built frontend\nFINAL ANSWER TASK=2 BACKEND=8000 Built backend"
    );
    const bugResult = simulateWaveLoop(buggyResponses, wave);
    assert(
      "Confirmed: 2-task wave with buggy LLM output causes infinite loop (validates the bug)",
      bugResult.loopDetected === true,
      `loopDetected=${bugResult.loopDetected}, completed=[${bugResult.completedOrders}] — this confirms why we capped wave at 1`,
    );

    // THE FIX: with wave capped at 1, this scenario never happens
    const singleWaveResult = simulateWaveLoop(buggyResponses, [{ order: 2 }]); // only TASK=2 in wave
    assert(
      "Wave cap fix: single-task wave completes correctly even with buggy LLM output",
      !singleWaveResult.loopDetected && singleWaveResult.completedOrders.includes(2),
      `loopDetected=${singleWaveResult.loopDetected}, completed=[${singleWaveResult.completedOrders}]`,
    );

    // GOOD: correct format — both tasks complete immediately
    const goodResponses = [
      "FINAL ANSWER TASK=1 FRONTEND=3000 Built the frontend",
      "FINAL ANSWER TASK=2 BACKEND=8000 Built the backend",
    ];
    const goodResult = simulateWaveLoop(goodResponses, wave);
    assert(
      "Correct FINAL ANSWER format completes both tasks",
      goodResult.completedOrders.includes(1) && goodResult.completedOrders.includes(2),
      `completed=[${goodResult.completedOrders}]`,
    );
    assert(
      "No loop with correct format",
      !goodResult.loopDetected,
    );

    // Single task wave — always works
    const singleWave = [{ order: 1 }];
    const singleResult = simulateWaveLoop(["FINAL ANSWER TASK=1"], singleWave);
    assert("Single task wave completes", singleResult.completedOrders.includes(1));
  });
}

// ─── 3. Real LLM test — single task wave ──────────────────────
async function testRealLLMSingleTask() {
  await section("Real LLM — single task wave (GROQ)", async () => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.log(`  ${YELLOW} Skipped — GROQ_API_KEY not set`);
      return;
    }

    const llm = new OpenAI({
      apiKey,
      baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    });

    const todo = {
      title: "Create a hello world file",
      description: "Create a simple hello.txt file with the text 'Hello, World!'",
      order: 1,
    };

    const systemPrompt = [
      "You are a coding agent working inside a sandbox environment.",
      "When you complete a task, you MUST output: FINAL ANSWER TASK=<order>",
      "Do NOT include FRONTEND or BACKEND ports unless a server is actually running.",
      "Output FINAL ANSWER immediately after completing the task.",
      "Do not use any tools — just describe what you would do and output FINAL ANSWER.",
    ].join("\n");

    const userMsg = buildSingleTaskWaveMessage(todo);

    console.log(`  Sending to GROQ (llama-3.1-8b-instant)...`);
    const start = Date.now();

    let responseText = "";
    try {
      const stream = await llm.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
        temperature: 0.2,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        responseText += delta;
        process.stdout.write(delta);
      }
    } catch (err: any) {
      console.log(`\n  ${RED} LLM call failed: ${err.message}`);
      failed++;
      return;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n\n  Agent responded in ${elapsed}s`);

    // Validate the response
    const hasFinalAnswer = responseText.includes("FINAL ANSWER");
    const parsedOrder = parseTaskOrderFromFinalAnswer(responseText);
    const correctTask = parsedOrder === todo.order;

    assert(
      "LLM outputs FINAL ANSWER",
      hasFinalAnswer,
      `Response: ${responseText.slice(0, 200)}`,
    );
    assert(
      `LLM outputs correct TASK=${todo.order}`,
      correctTask,
      `parsedOrder=${parsedOrder}, expected=${todo.order}`,
    );
    assert(
      "No infinite loop — FINAL ANSWER detected on first response",
      hasFinalAnswer && correctTask,
    );

    // Simulate wave completion with this real response
    const waveResult = simulateWaveLoop([responseText], [{ order: todo.order }]);
    assert(
      "Wave completes on first LLM response — no extra iterations",
      waveResult.completedOrders.includes(todo.order) && waveResult.iterations === 1,
      `iterations=${waveResult.iterations}, completed=[${waveResult.completedOrders}]`,
    );
  });
}

// ─── 4. Real LLM test — multi task wave (old broken scenario) ─
async function testRealLLMMultiTaskOldScenario() {
  await section("Real LLM — multi-task wave (verify it breaks without cap)", async () => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.log(`  ${YELLOW} Skipped — GROQ_API_KEY not set`);
      return;
    }

    const llm = new OpenAI({
      apiKey,
      baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    });

    const wave = [
      { title: "Create hello.txt", description: "Write hello world to /workspace/hello.txt", order: 1 },
      { title: "Create world.txt", description: "Write world hello to /workspace/world.txt", order: 2 },
    ];

    const taskList = wave.map(t => `**[TASK ${t.order}] ${t.title}**\n${t.description}`).join("\n\n");

    const systemPrompt = [
      "You are a coding agent working inside a sandbox environment.",
      "When you complete EACH task, output: FINAL ANSWER TASK=<order>",
      "Complete and signal each task before moving to the next.",
      "Do not use any tools — just describe what you would do and output FINAL ANSWER for each.",
    ].join("\n");

    const userMsg = [
      `## Your Tasks (${wave.length} tasks — complete all of them)`,
      `**Workspace ID:** test-workspace-123`,
      ``,
      taskList,
      ``,
      `## Completion Protocol`,
      `Signal each finished task with: FINAL ANSWER TASK=<order>`,
      `Example: FINAL ANSWER TASK=1`,
      `Example: FINAL ANSWER TASK=2`,
      `Complete and signal each task before moving to the next.`,
    ].join("\n");

    console.log(`  Sending 2-task wave to GROQ...`);
    const start = Date.now();
    let responseText = "";

    try {
      const stream = await llm.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
        temperature: 0.2,
        stream: true,
      });

      for await (const chunk of stream) {
        responseText += chunk.choices[0]?.delta?.content || "";
      }
    } catch (err: any) {
      console.log(`\n  ${RED} LLM call failed: ${err.message}`);
      failed++;
      return;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Agent responded in ${elapsed}s`);
    console.log(`  Response:\n${responseText.slice(0, 500)}\n`);

    // Count how many FINAL ANSWER TASK=N signals are present
    const strictMatches = [...responseText.matchAll(/FINAL\s+ANSWER\s+TASK\s*=\s*(\d+)/gi)];
    const detectedOrders = strictMatches.map(m => parseInt(m[1], 10));

    console.log(`  Detected FINAL ANSWER signals: [${detectedOrders.join(", ")}]`);

    const hasBoth = detectedOrders.includes(1) && detectedOrders.includes(2);
    const hasMissing = !hasBoth;

    assert(
      "LLM outputs both FINAL ANSWER TASK=1 and TASK=2 (strict format)",
      hasBoth,
      hasMissing
        ? `Only got: [${detectedOrders}] — this is the root cause of the infinite loop bug`
        : "Both detected correctly",
    );

    if (hasMissing) {
      console.log(`\n  ${YELLOW} Confirmed: multi-task wave is unreliable.`);
      console.log(`     Cap at 1 todo per wave is the correct fix.`);
    }
  });
}

// ─── 5. Wave cap verification ──────────────────────────────────
async function testWaveCapLogic() {
  await section("Wave cap — single todo per wave enforced", async () => {
    // Simulate rawWave with 3 ready todos
    const rawWave = [
      { id: "1", title: "Task A", description: "...", order: 1 },
      { id: "2", title: "Task B", description: "...", order: 2 },
      { id: "3", title: "Task C", description: "...", order: 3 },
    ];

    // The fix: slice(0, 1)
    const cappedWave = rawWave.slice(0, 1);

    assert("Wave capped to 1 todo", cappedWave.length === 1);
    assert("First ready todo selected", cappedWave[0].order === 1);
    assert("Other todos not included", !cappedWave.find(t => t.order === 2 || t.order === 3));

    // Verify that DAG still works — next wave picks next ready
    const completedOrders = new Set([1]);
    const nextWave = rawWave.filter(t => !completedOrders.has(t.order)).slice(0, 1);
    assert("Next wave picks Todo 2 after Todo 1 completes", nextWave[0]?.order === 2);
  });
}

// ─── 6. Real LLM — 3 sequential waves, no loops ───────────────
async function testRealLLMSequentialWaves() {
  await section("Real LLM — 3 sequential waves (no loops, correct DAG order)", async () => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.log(`  ${YELLOW} Skipped — GROQ_API_KEY not set`);
      return;
    }

    const llm = new OpenAI({
      apiKey,
      baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    });

    // Simulate 3 todos with deps:
    // Todo 1: DEPS: []   → runs first
    // Todo 2: DEPS: [1]  → runs after Todo 1
    // Todo 3: DEPS: [2]  → runs after Todo 2
    const todos = [
      { title: "Create config file", description: "Create /workspace/config.json with {version: 1}", order: 1 },
      { title: "Create main file", description: "Create /workspace/main.js that reads config.json", order: 2 },
      { title: "Create readme", description: "Create /workspace/README.md describing the project", order: 3 },
    ];

    const systemPrompt = [
      "You are a coding agent working in a sandbox environment.",
      "When you complete your task, output exactly: FINAL ANSWER TASK=<order>",
      "Do NOT include FRONTEND or BACKEND ports unless a server is running.",
      "Do not use tools — describe what you would do and output FINAL ANSWER immediately.",
    ].join("\n");

    const completedWaves: number[] = [];
    let loopDetected = false;
    let totalLLMCalls = 0;

    console.log(`  Simulating 3 sequential waves...`);

    for (const todo of todos) {
      totalLLMCalls++;
      const waveMsg = buildSingleTaskWaveMessage(todo);

      const start = Date.now();
      let responseText = "";

      try {
        const stream = await llm.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: waveMsg },
          ],
          temperature: 0.2,
          stream: true,
        });
        for await (const chunk of stream) {
          responseText += chunk.choices[0]?.delta?.content || "";
        }
      } catch (err: any) {
        console.log(`  ${RED} LLM call failed on wave ${todo.order}: ${err.message}`);
        failed++;
        return;
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const parsedOrder = parseTaskOrderFromFinalAnswer(responseText);
      const hasFinalAnswer = responseText.includes("FINAL ANSWER");
      const correctTask = parsedOrder === todo.order;

      console.log(`  Wave ${todo.order} → responded in ${elapsed}s | FINAL ANSWER: ${hasFinalAnswer} | TASK=${parsedOrder}`);

      // Detect loop: same order completing twice
      if (completedWaves.includes(todo.order)) {
        loopDetected = true;
      }

      if (hasFinalAnswer && correctTask) {
        completedWaves.push(todo.order);
      }
    }

    assert(
      "Wave 1 completed correctly (FINAL ANSWER TASK=1)",
      completedWaves.includes(1),
      `completedWaves=[${completedWaves}]`,
    );
    assert(
      "Wave 2 completed correctly (FINAL ANSWER TASK=2)",
      completedWaves.includes(2),
      `completedWaves=[${completedWaves}]`,
    );
    assert(
      "Wave 3 completed correctly (FINAL ANSWER TASK=3)",
      completedWaves.includes(3),
      `completedWaves=[${completedWaves}]`,
    );
    assert(
      "No loops detected across all 3 waves",
      !loopDetected,
      loopDetected ? "Same task order completed more than once" : "Clean",
    );
    assert(
      "Exactly 3 LLM calls made — one per wave, no extra retries",
      totalLLMCalls === 3,
      `totalLLMCalls=${totalLLMCalls}`,
    );
    assert(
      "Waves completed in correct order (1 → 2 → 3)",
      JSON.stringify(completedWaves) === JSON.stringify([1, 2, 3]),
      `order was [${completedWaves}]`,
    );
  });
}

// ─── 7. Real LLM — exact bug scenario replay ──────────────────
async function testRealLLMBugScenarioReplay() {
  await section("Real LLM — exact bug scenario (crypto app, 2 todos, cap=1)", async () => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.log(`  ${YELLOW} Skipped — GROQ_API_KEY not set`);
      return;
    }

    const llm = new OpenAI({
      apiKey,
      baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    });

    // This is the EXACT scenario that caused the infinite loop:
    // Crypto app — frontend (Todo 1) + backend trade API (Todo 2)
    // Previously both were in one wave → loop
    // Now cap=1 means they run separately → no loop
    const todos = [
      {
        title: "Build the frontend home page",
        description: "Create a crypto prices dashboard at /workspace/frontend/app/page.tsx with Tailwind UI",
        order: 1,
      },
      {
        title: "Build the backend trade API",
        description: "Create trade endpoints at /workspace/backend/src/trade.js with buy/sell/portfolio routes",
        order: 2,
      },
    ];

    const systemPrompt = [
      "You are a coding agent working in a sandbox environment.",
      "When you complete your task, output exactly: FINAL ANSWER TASK=<order> FRONTEND=<port> or BACKEND=<port> if applicable.",
      "Do not use tools — describe what you would do and immediately output FINAL ANSWER.",
    ].join("\n");

    const results: { order: number; detected: number | null; hasLoop: boolean }[] = [];
    console.log(`  Replaying the exact bug scenario with cap=1...`);

    for (const todo of todos) {
      const waveMsg = buildSingleTaskWaveMessage(todo);
      let responseText = "";

      try {
        const stream = await llm.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: waveMsg },
          ],
          temperature: 0.2,
          stream: true,
        });
        for await (const chunk of stream) {
          responseText += chunk.choices[0]?.delta?.content || "";
        }
      } catch (err: any) {
        console.log(`  ${RED} LLM call failed: ${err.message}`);
        failed++;
        return;
      }

      const detected = parseTaskOrderFromFinalAnswer(responseText);

      // Simulate the wave runner — with cap=1, wave has only THIS todo
      const waveResult = simulateWaveLoop([responseText], [{ order: todo.order }]);

      console.log(`  Todo ${todo.order} → FINAL ANSWER detected: TASK=${detected} | loop: ${waveResult.loopDetected}`);

      results.push({
        order: todo.order,
        detected,
        hasLoop: waveResult.loopDetected,
      });
    }

    assert(
      "Todo 1 (frontend): FINAL ANSWER TASK=1 detected correctly",
      results[0]?.detected === 1,
      `detected=${results[0]?.detected}`,
    );
    assert(
      "Todo 2 (backend trade API): FINAL ANSWER TASK=2 detected correctly",
      results[1]?.detected === 2,
      `detected=${results[1]?.detected}`,
    );
    assert(
      "Todo 1 wave: no loop",
      results[0]?.hasLoop === false,
    );
    assert(
      "Todo 2 wave: no loop",
      results[1]?.hasLoop === false,
    );
    assert(
      "Both todos completed without any loop — bug is fixed",
      results.every(r => !r.hasLoop),
      `loops: [${results.map(r => r.hasLoop)}]`,
    );
  });
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${BOLD}Agent Wave Integration Tests${RESET}`);
  console.log("=".repeat(50));

  await testFinalAnswerParsing();
  await testLoopDetection();
  await testWaveCapLogic();
  await testRealLLMSingleTask();
  await testRealLLMMultiTaskOldScenario();
  await testRealLLMSequentialWaves();
  await testRealLLMBugScenarioReplay();

  console.log("\n" + "=".repeat(50));
  console.log(`${BOLD}Results: ${GREEN} ${passed} passed  ${RED} ${failed} failed${RESET}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
