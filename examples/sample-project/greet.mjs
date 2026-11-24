// Prints a greeting for each name given on the command line.
export function greet(name) {
  return `Hello, ${name}!`;
}

for (const name of process.argv.slice(2)) console.log(greet(name));
