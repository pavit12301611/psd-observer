// test_system_prompt.ts

// Adjust the path if this test file is not in the project root directory
import getSystemPrompt from './system_prompt.ts';

console.log("--- Testing getSystemPrompt() ---");
console.log("Running getSystemPrompt to check the output string...");

// Call the function to get the prompt string
const promptString = getSystemPrompt();

console.log("\n--- Generated System Prompt Start ---\n");
// Print the resulting string to the console
console.log(promptString);
console.log("\n--- Generated System Prompt End ---\n");

console.log("Test complete. Review the output above.");
