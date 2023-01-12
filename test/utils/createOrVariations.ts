export function createOrVariations(multilineString: string): string[] {
  if (multilineString.includes('OR')) {
    const baseLines: string[] = [];

    const lines = multilineString.split('\n');
    const orVariations: string[][] = [[]];
    let currentOrVariationIndex = 0;
    let isOrBlock = false;

    for (const line of lines) {
      const trimmedLine = line.trimStart();

      if (!isOrBlock && trimmedLine.startsWith('---')) {
        isOrBlock = true;
        baseLines.push('---block-placeholder---');
        continue;
      }

      if (isOrBlock && trimmedLine.startsWith('OR')) {
        orVariations.push([]);
        currentOrVariationIndex++;
        continue;
      }

      if (isOrBlock && trimmedLine.startsWith('---')) {
        isOrBlock = false;
        continue;
      }

      if (isOrBlock) {
        orVariations[currentOrVariationIndex]!.push(line);
        continue;
      }

      baseLines.push(line);
    }

    return orVariations.map((variation) =>
      baseLines
        .flatMap((line) =>
          line === '---block-placeholder---' ? variation : [line],
        )
        .join('\n'),
    );
  } else {
    return [multilineString];
  }
}
