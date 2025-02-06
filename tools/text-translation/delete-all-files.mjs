import OpenAI from "openai";

const openai = new OpenAI();

async function deleteAllFiles() {
  const list = await openai.files.list({ purpose: "batch" });

  console.log(`Found ${list.data.length} files`);
  for (const file of list.data) {
    console.log(`File name: ${file.filename}`);

    // await openai.files.del(file.id);

    if (file.filename.includes('polish')) {
      continue;
    }

    console.log(`Content of file: ${file.filename}`);
    const content = await openai.files.content(file.id);
    console.log(content);

  }
}

deleteAllFiles();