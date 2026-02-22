const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI("PASTE_NEW_KEY");

async function run(){
  const models = await genAI.listModels();
  console.log(models);
}

run();
