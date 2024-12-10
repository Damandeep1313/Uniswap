const fs = require('fs');

function getTokenMapping(inputFilePath, outputFilePath) {
  const lines = fs.readFileSync(inputFilePath, 'utf8').split('\n');
  const mapping = {};

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('ContractAddress')) continue;

    const parts = line.split(',');
    if (parts.length < 3) {
      // If line doesn't have at least 3 columns, skip it
      continue;
    }

    const contractAddress = parts[0].trim();
    const tokenName = parts[1].trim();
    const tokenSymbol = parts[2].trim();

    mapping[contractAddress] = {
      name: tokenName,
      symbol: tokenSymbol
    };
  }

  // Write the mapping to the output file as JSON
  fs.writeFileSync(outputFilePath, JSON.stringify(mapping, null, 2), 'utf8');
}

// Example usage:
getTokenMapping('./tokens.txt', './mapping.json');
