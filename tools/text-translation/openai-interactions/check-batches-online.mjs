//check if there are in progress batches

import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI();

async function cancelBatch(batchId) {
  return openai.batches.cancel(batchId);
}

async function getFile(fileId) {
  return openai.files.retrieve(fileId);
}

async function getAllBatches() {
  let allBatches = [];

  let list = await openai.batches.list({ limit: 100 });

  do {
    allBatches = allBatches.concat(list.data);
    list = await list.getNextPage();
    console.log(`Fetched ${allBatches.length} batches`);
  } while (list.hasNextPage());

  return allBatches;
}

async function main() {
  let allBatches = await getAllBatches();

  console.log(allBatches.length);

  const inProgressBatches = allBatches.filter(batch => batch.status === "in_progress");
  console.log(`In progress batches: ${inProgressBatches.length}`);

  const failedBatches = allBatches.filter(batch => batch.status === "failed");
  console.log(`Failed batches: ${failedBatches.length}`);

  const completedBatches = allBatches.filter(batch => batch.status === "completed");
  console.log(`Completed batches: ${completedBatches.length}`);

  const canceledBatches = allBatches.filter(batch => batch.status === "cancelled");
  console.log(`Cancelled batches: ${canceledBatches.length}`);

  console.log(`Calculated amount of batches: ${inProgressBatches.length + failedBatches.length + completedBatches.length + canceledBatches.length}`);


  const otherBatches = allBatches.filter(batch => batch.status !== "in_progress" && batch.status !== "failed" && batch.status !== "completed" && batch.status !== "cancelled");
  console.log(`Other batches: ${otherBatches.length}`);

  for (const batch of otherBatches) {
    console.log(`Batch ${batch.id} is in status ${batch.status}`);
  }
}

async function cancelAllBatches() {
  let allBatches = await getAllBatches();

  const inProgressBatches = allBatches.filter(batch => batch.status === "in_progress");

  console.log(`Cancelling ${inProgressBatches.length} in progress batches`);

  for (const batch of inProgressBatches) {
    console.log(`Cancelling batch ${batch.id}`);
    await cancelBatch(batch.id);
  }
}

async function formatTimeFromSeconds(seconds) {
  const minutes = Math.floor(seconds / 60);

  return `${minutes % 60} minutes, ${seconds % 60} seconds`;
}

async function checkBatchesFromFile(filename) {
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));

  console.log(`Checking ${data.length} batches.`);

  for (const batch of data) {
    const remoteBatch = await openai.batches.retrieve(batch.id);

    if (remoteBatch.status === "completed") {
      console.log(`Batch ${batch.id} is completed.`);
    } else if (remoteBatch.status === "failed") {
      const currentTime = Date.now() / 1000;
      const failedAgo = await formatTimeFromSeconds(currentTime - remoteBatch.failed_at);
      console.log(`Batch ${remoteBatch.id} has failed. It failed ${failedAgo} ago.`);
    } else {
      console.log(`Batch ${batch.id} is in status ${remoteBatch.status})`);
    }
  }
}

while (true) {
  // await main();
  // await cancelAllBatches();
  await checkBatchesFromFile("batches-in-progress.json");
  // await new Promise(resolve => setTimeout(resolve, 30000));
  break;
}