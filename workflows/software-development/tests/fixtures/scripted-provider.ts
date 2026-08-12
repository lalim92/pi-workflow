import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let callNumber = 0;

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function createMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function textStream(model: Model<any>, text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = createMessage(model);

  queueMicrotask(() => {
    message.content.push({ type: "text", text: "" });
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    message.content[0].text = text;
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    message.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });

  return stream;
}

function toolStream(
  model: Model<any>,
  name: string,
  argumentsValue: Record<string, unknown>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = createMessage(model);
  const toolCall = {
    type: "toolCall" as const,
    id: `scripted-call-${callNumber}`,
    name,
    arguments: argumentsValue,
  };

  queueMicrotask(() => {
    message.content.push(toolCall);
    stream.push({ type: "start", partial: message });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
    message.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end();
  });

  return stream;
}

function scriptedStream(model: Model<any>, _context: unknown, _options?: SimpleStreamOptions) {
  callNumber += 1;

  switch (callNumber) {
    case 1:
      return textStream(model, [
        "# Implementation Plan\n",
        "Create the requested file, review the change, and validate it.\n\n",
        "WORKFLOW_STATUS: PLAN_READY",
      ].join(""));
    case 2:
      return toolStream(model, "write", {
        path: "scripted-output.txt",
        content: "initial scripted content\n",
      });
    case 3:
      return textStream(model, "Implementation is complete.\nWORKFLOW_STATUS: IMPLEMENTATION_COMPLETE\nWORKFLOW_COMMIT: feat: add scripted output");
    case 4:
      return textStream(model, "The initial content should be corrected.\nWORKFLOW_STATUS: REVIEW_FINDINGS");
    case 5:
      return toolStream(model, "write", {
        path: "scripted-output.txt",
        content: "corrected scripted content\n",
      });
    case 6:
      return textStream(model, "The review findings were fixed.\nWORKFLOW_STATUS: FIXES_COMPLETE");
    case 7:
      return textStream(model, "The corrected change is sound.\nWORKFLOW_STATUS: REVIEW_NO_FINDINGS");
    case 8:
      return textStream(model, "Final validation passed.\nWORKFLOW_STATUS: VALIDATION_PASSED");
    default:
      return textStream(model, "Unexpected scripted provider call.");
  }
}

export default function scriptedWorkflowProvider(pi: ExtensionAPI) {
  pi.registerProvider("scripted-workflow", {
    name: "Scripted Workflow Provider",
    baseUrl: "http://scripted.invalid",
    apiKey: "test",
    api: "openai-completions",
    models: [
      {
        id: "workflow-scripted",
        name: "Workflow Scripted",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_000,
      },
    ],
    streamSimple: scriptedStream,
  });
}
