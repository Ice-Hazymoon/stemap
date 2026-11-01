import { Queue, Worker } from "bullmq";

export const emailQueue = new Queue("email");
export const reportQueue = new Queue("report");

new Worker("email", async (job) => {
  await deliver(job.data);
});

async function deliver(_data: unknown) {}

export async function enqueue() {
  await emailQueue.add("welcome", { to: "a@b.c" });
  await reportQueue.add("daily", {});
}
