import fs from 'fs';

async function checkTokensInResponse(response) {
    const responseArray = response.split('\n');

    let totalTokens = 0;

    for (const response of responseArray) {
        if (!response) {
            continue;
        }
        const responseObj = JSON.parse(response);
        // console.log(responseObj);
        // break;
        totalTokens += responseObj.response.body.usage.total_tokens;
        console.log(totalTokens);
    }

    console.log(`Average tokens per response: ${totalTokens / responseArray.length}`);
    console.log(`Expected amount of requests per 90000 tokens: ${Math.ceil(responseArray.length / (totalTokens / 90000))}`);
}

async function main() {
    const response = fs.readFileSync('./responses/polish-batch-10.jsonl', 'utf8');
    await checkTokensInResponse(response);
}

main();