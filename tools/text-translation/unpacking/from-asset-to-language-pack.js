const fs = require('fs');


const generalPolishPath = './GeneralLockitPolish-CAB-b6e8394f6873fd0329dbffde4b628d06--3139649057205837429.json';
const dialoguesPolishPath = './DialoguesLockitPolish-CAB-b6e8394f6873fd0329dbffde4b628d06-6997357359526687922.json';

const simpleGeneralPolishPath = './general-polish.json';
const simpleDialoguesPolishPath = './dialogues-polish.json';

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function packGeneralPolish() {
    const generalPolish = readJsonFile(generalPolishPath);

    const simpleGeneralPolish = {};

    for (const term of generalPolish.mSource.mTerms.Array) {
        simpleGeneralPolish[term.Term] = {
            polish: term.Languages.Array[0],
            translate: true
        };
    }

    writeJsonFile(simpleGeneralPolishPath, simpleGeneralPolish);
}

function packDialoguesPolish() {
    const dialoguesPolish = readJsonFile(dialoguesPolishPath);

    const simpleDialoguesPolish = {};

    for (const term of dialoguesPolish.mSource.mTerms.Array) {
        simpleDialoguesPolish[term.Term] = {
            polish: term.Languages.Array[0],
            translate: true
        };
    }

    writeJsonFile(simpleDialoguesPolishPath, simpleDialoguesPolish);
}

function execute() {
    packGeneralPolish();
    packDialoguesPolish();
}

execute();