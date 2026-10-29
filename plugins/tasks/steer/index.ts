import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api/index.js";
import { withTaskExecution } from "../delegate/execution.js";
import { errorMessage } from "../shared/errors";
import { isSideChatShapedThread } from "../shared/side-chat";
import { assertTaskWorkflowExecutionAvailable } from "../workflow/store.js";

interface DeliverCommentInput {
  taskId: string;
  commentId: string;
  body: string;
  authorName: string;
}

function steerPrompt(
  taskKey: string,
  authorName: string,
  body: string,
): string {
  return (
    `New comment on task ${taskKey} from ${authorName}: ${body}\n\n` +
    "Treat this as updated context for your work on this task; " +
    `reply via bb tasks comment ${taskKey} when relevant.`
  );
}

export async function deliverCommentToLatestAgent(
  bb: BbPluginApi,
  store: TasksApiStore,
  input: DeliverCommentInput,
): Promise<number> {
  const task = store.tasks.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);

  const latestReply = store.tasks.getLatestAgentComment(
    input.taskId,
    input.commentId,
  );
  if (!latestReply || latestReply.threadId === null) return 0;

  const threadId = latestReply.threadId;
  const prompt = steerPrompt(task.key, input.authorName, input.body);
  try {
    return await withTaskExecution(input.taskId, async () => {
      assertTaskWorkflowExecutionAvailable(store, input.taskId);
      const thread = await bb.sdk.threads.get({ threadId });
      if (isSideChatShapedThread(thread)) return 0;
      assertTaskWorkflowExecutionAvailable(store, input.taskId);
      await bb.sdk.threads.send({
        threadId,
        input: [{ type: "text", text: prompt, mentions: [] }],
        mode: "steer-if-active",
      });
      return 1;
    });
  } catch (error) {
    bb.log.warn(
      `failed to deliver comment ${input.commentId} to thread ${threadId}: ${errorMessage(error)}`,
    );
    return 0;
  }
}
