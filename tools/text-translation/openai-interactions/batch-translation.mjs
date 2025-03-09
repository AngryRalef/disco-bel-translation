import fs from 'fs';
import OpenAI from 'openai';
import { v4 as uuid } from 'uuid';

const openai = new OpenAI();

const polishPath = './dialogues-polish.json';
const belarusianPath = './dialogues-belarusian.json';
const responsesFolder = './responses';

/**
 * create separate batch files for each 49000 dialogues
 * @param polishPathFrom
 * @param inputBatchDirectory
 */
async function createBatchFiles(polishPathFrom, inputBatchDirectory) {
    const polishText = JSON.parse(fs.readFileSync(polishPathFrom, 'utf8'));

    if (!fs.existsSync(inputBatchDirectory)) {
        fs.mkdirSync(inputBatchDirectory);
    }

    let counter = 0;
    let batchCounter = fs.readdirSync(inputBatchDirectory).length;

    for (const [id, term] of Object.entries(polishText)) {
        counter++;

        if (counter === 100) {
            counter = 0;
            batchCounter++;
        }

        const inputBatchPath = `${inputBatchDirectory}/polish-batch-${batchCounter}.jsonl`;

        if (!fs.existsSync(inputBatchPath)) {
            fs.writeFileSync(inputBatchPath, '', 'utf8');
        }

        const request = {
            "custom_id": id,
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": "gpt-4o",
                "messages": [
                    {
                        "role": "developer",
                        "content": "User will provide text in Polish. Translate this text into Belarusian. Do not try to answer the question or continue the conversation. Just translate the text."
                    },
                    {
                        "role": "user",
                        "content": term.polish
                    }
                ],
                "max_completion_tokens": 400,
            }
        }
        fs.appendFileSync(inputBatchPath, JSON.stringify(request) + '\n');
    }
}

async function uploadBatchFile(inputBatchPath) {
    console.log(`Uploading file ${inputBatchPath}`);
    return openai.files.create({
        file: fs.createReadStream(inputBatchPath),
        purpose: "batch",
    });
}

async function changeFileToBatch(fileId) {
    return openai.batches.create({
        input_file_id: fileId,
        endpoint: "/v1/chat/completions",
        completion_window: "24h"
    });
}

async function checkIfThereAreResponseFileAlready(fileId) {
    const remoteFile = await openai.files.retrieve(fileId);

    const responses = fs.readdirSync(responsesFolder);

    return !!responses.includes(remoteFile.filename);
}

async function getRemoteBatch(batchId) {
    return openai.batches.retrieve(batchId);
}

async function retrieveResponseFile(fileId, filename){
    const fileResponse = await openai.files.content(fileId);
    const fileContents = await fileResponse.text();

    if (!fs.existsSync(responsesFolder)) {
        fs.mkdirSync(responsesFolder);
    }

    if (!fs.existsSync(responsesFolder + '/' + filename)) {
        fs.writeFileSync(responsesFolder + '/' + filename, '', 'utf8');
    }

    fs.writeFileSync(responsesFolder + '/' + filename, fileContents, 'utf8');
}

async function convertResponseToJson(responseFilePath, originalPath){
    const response = fs.readFileSync(responseFilePath, 'utf8');
    const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));

    const responseArray = response.split('\n');
    const responseJson = {};


    for (const response of responseArray) {
        if (!response) {
            continue;
        }
        const responseObj = JSON.parse(response);
        responseJson[responseObj.custom_id] = {
            polish: original[responseObj.custom_id].polish,
            belarusian: responseObj.response.body.choices[0].message.content
        };
    }

    return responseJson;
}

async function sendBatchFiles(batchFilesDirectory, responsesDirectory, batchesInProgressPath) {
    let files = fs.readdirSync(batchFilesDirectory);

    if (!fs.existsSync(responsesDirectory)) {
        fs.mkdirSync(responsesDirectory);
    }

    const responses = fs.readdirSync(responsesDirectory);

    files = files.filter(file => !responses.includes(file));

    console.log(files.length + ' files to process');

    if (!fs.existsSync(batchesInProgressPath)) {
        fs.writeFileSync(batchesInProgressPath, '[]', 'utf8');
    }

    let batchesInProgress = JSON.parse(fs.readFileSync(batchesInProgressPath, 'utf8'));

    for (const file of files) {
        const inputBatchPath = `${batchFilesDirectory}/${file}`;
        const fileResponse = await uploadBatchFile(inputBatchPath);
        const batchResponse = await changeFileToBatch(fileResponse.id);
        batchesInProgress.push(batchResponse);
    }
    console.log('Batches in progress: ' + batchesInProgress.length);

    fs.writeFileSync(batchesInProgressPath, JSON.stringify(batchesInProgress, null, 2));
}

async function getFileName(fileId) {
    const fileResponse = await openai.files.retrieve(fileId);
    return fileResponse?.filename;
}

async function checkAndRetrieveBatches(batchInProgressPath, failedBatchPath, successfulBatchPath) {
    const batches = JSON.parse(fs.readFileSync(batchInProgressPath, 'utf8'));

    let resultingBatches = batches;

    if (!fs.existsSync(failedBatchPath)) {
        fs.writeFileSync(failedBatchPath, '[]', 'utf8');
    }
    const failedBatches = JSON.parse(fs.readFileSync(failedBatchPath, 'utf8'));

    if (!fs.existsSync(successfulBatchPath)) {
        fs.writeFileSync(successfulBatchPath, '[]', 'utf8');
    }

    const successfulBatches = JSON.parse(fs.readFileSync(successfulBatchPath, 'utf8'));


    let amountOfBatchesRemotelyInProgress = 0;
    let batchCounter = 0;

    for (const batch of batches) {
        const remoteBatch = await getRemoteBatch(batch.id);

        batchCounter++;
        console.log(`Checking batch [${batchCounter}/${batches.length}]. ID: ${batch.id}...`);

        if (await checkIfThereAreResponseFileAlready(remoteBatch.input_file_id)) {
            const filename = await getFileName(remoteBatch.input_file_id);
            console.log(`Response file with name ${filename} for batch ${batch.id} already exists. Removing batch from the list.`);
            resultingBatches = resultingBatches.filter(b => b.id !== batch.id);
            continue;
        }

        if (remoteBatch.status === "completed") {
            const filename = await getFileName(remoteBatch.input_file_id) ?? uuid() + '.jsonl';
            await retrieveResponseFile(remoteBatch.output_file_id, filename);
            console.log(`Batch ${batch.id} is completed.`);
            successfulBatches.push(batch);
            resultingBatches = resultingBatches.filter(b => b.id !== batch.id);

            continue;
        }

        console.log(`Batch ${batch.id} is not completed yet. Status: ${remoteBatch.status}`);

        if (remoteBatch.status === "failed") {
            // if it failed because of token_limit_exceeded, we should retry
            if (remoteBatch.errors.data.some(error => error.code === 'token_limit_exceeded')) {
                if (remoteBatch.errors.data.length > 1) {
                    console.log(remoteBatch.errors);
                } else {
                    // console.log(remoteBatch.errors.data.find(error => error.code === 'token_limit_exceeded')?.message);
                }

                if (amountOfBatchesRemotelyInProgress > 100) {
                    console.log('There are other batches in progress. Retrying later...');
                    continue;
                }
                console.log('Retrying batch...');
                const newBatch = await changeFileToBatch(remoteBatch.input_file_id);
                console.log(`New batch id: ${newBatch.id}`);
                resultingBatches.push(newBatch);
                resultingBatches = resultingBatches.filter(b => b.id !== batch.id);
                amountOfBatchesRemotelyInProgress++;
            } else {
                console.error(remoteBatch.errors);
                failedBatches.push(remoteBatch);
                // if it failed because of other reasons, we should remove it from the list
                resultingBatches = resultingBatches.filter(b => b.id !== batch.id);
            }
        }

        if (remoteBatch.status !== "completed" && remoteBatch.status !== "failed") {
            amountOfBatchesRemotelyInProgress++;
        }
    }

    console.log(`Amount of batches in progress changed from ${batches.length - 1} to ${resultingBatches.length}`);
    console.log('Amount of batches in progress remotely: ' + amountOfBatchesRemotelyInProgress);

    fs.writeFileSync(failedBatchPath, JSON.stringify(failedBatches, null, 2));
    fs.writeFileSync(successfulBatchPath, JSON.stringify(successfulBatches, null, 2));
    fs.writeFileSync(batchInProgressPath, JSON.stringify(resultingBatches, null, 2));
}

async function responseFilesIntoResult(responseFolder, resultPath, originalPath) {
    if (!fs.existsSync(resultPath)) {
        fs.writeFileSync(resultPath, '{}', 'utf8');
    }

    for (const file of fs.readdirSync(responseFolder)) {

        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const jsonResponses = await convertResponseToJson(responseFolder + '/' + file, originalPath);

        for (const [id, response] of Object.entries(jsonResponses)) {
            result[id] = response;
        }

        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    }
}

async function formatTimeFromMilliseconds(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);

    return `${minutes % 60} minutes, ${seconds % 60} seconds`;
}

async function processQueueUntilFinished(batchesInProgressPath, failedBatchPath, successfulBatchPath) {
    while (true) {
        console.log('Checking batches...');
        const timeStart = new Date().getTime();

        await checkAndRetrieveBatches(batchesInProgressPath, failedBatchPath, successfulBatchPath);

        const failedBatches = JSON.parse(fs.readFileSync(failedBatchPath, 'utf8')).length;
        const successfulBatches = JSON.parse(fs.readFileSync(successfulBatchPath, 'utf8')).length;
        const batchesInProgress = JSON.parse(fs.readFileSync(batchesInProgressPath, 'utf8')).length;

        console.log(`Failed batches: ${failedBatches}`);
        console.log(`Successful batches: ${successfulBatches}`);
        console.log(`Batches in progress: ${batchesInProgress}`);

        const timeEnd = new Date().getTime();
        console.log(`Time spent: ${await formatTimeFromMilliseconds(timeEnd - timeStart)}`);

        if (batchesInProgress === 0) {
            console.log('All batches are completed.');
            break;
        }


        const waitTime = 60000; // 1 minutes
        console.log(`Waiting ${waitTime / 60000} minutes...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
}

async function execute() {
    // await createBatchFiles(polishPath, './batch-files');
    // await sendBatchFiles('./batch-files', responsesFolder,'./batches-in-progress.json');
    // await checkAndRetrieveBatches('./batches-in-progress.json', './failed-batches.json', './successful-batches.json');
    // await processQueueUntilFinished('./batches-in-progress.json', './failed-batches.json', './successful-batches.json');
    await responseFilesIntoResult(responsesFolder, './dialogues-translated.json', polishPath);
}


execute().then().catch(e => console.error(e));