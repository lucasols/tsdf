/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
export function jsonFormatter(
  value: any,
  options: {
    maxLength?: number;
    maxArrayItems?: number;
    maxObjKeys?: number;
    maxNestedDepth?: number;
    maxNestedStringSize?: number;
  } = {},
  inheritedIndentation = '',
  depth = 0,
): string {
  const {
    maxLength = 150,
    maxArrayItems = 16,
    maxObjKeys = 10,
    maxNestedDepth = 7,
    maxNestedStringSize = 100,
  } = options;

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  if (typeof value === 'string') {
    if (depth > 0 && value.length > maxNestedStringSize) {
      return `'${value.slice(0, maxNestedStringSize)}...'`;
    }

    return `'${value}'`;
  }

  if (Array.isArray(value)) {
    if (depth >= maxNestedDepth) {
      return '[...]';
    }

    const items: string[] = [];
    let length = inheritedIndentation.length;

    for (const item of value) {
      const itemContent = jsonFormatter(
        item,
        options,
        `${inheritedIndentation}  `,
        depth + 1,
      );

      length += itemContent.length;

      items.push(itemContent);
    }

    const shortArraySeparator = ', ';

    if (
      length + 2 * 2 + (items.length - 1) * shortArraySeparator.length <=
      maxLength
    ) {
      if (items.length === 0) {
        return '[]';
      }

      return `[ ${items.join(shortArraySeparator)} ]`;
    } else {
      let result = `${inheritedIndentation}[\n`;
      const indentation = `${inheritedIndentation}  `;
      let i = 0;

      for (const item of items) {
        if (i >= maxArrayItems) {
          result += `${indentation}... +${
            items.length - maxArrayItems
          } items\n`;
          break;
        }

        result += `${indentation + item},\n`;
        i++;
      }

      result += `${inheritedIndentation}]`;

      return result;
    }
  }

  if (typeof value === 'object') {
    if (value instanceof Date) {
      return `Date(${value.toISOString()})`;
    }

    if (value instanceof RegExp) {
      return `RegExp(${value.toString()})`;
    }

    if (value instanceof Error) {
      return `Error('${value.toString().replace(/^Error: /, '')}')`;
    }

    if (depth >= maxNestedDepth) {
      return '{...}';
    }

    const keys = Object.keys(value);
    const items: string[] = [];
    let length = inheritedIndentation.length;

    for (const key of keys) {
      const itemContent = `${key}: ${jsonFormatter(
        value[key],
        options,
        `${inheritedIndentation}  `,
        depth + 1,
      )}`;

      length += itemContent.length;

      items.push(itemContent);
    }

    const shortObjectSeparator = ', ';

    if (
      length + 2 * 2 + (items.length - 1) * shortObjectSeparator.length <=
      maxLength
    ) {
      if (items.length === 0) {
        return '{}';
      }

      return `{ ${items.join(shortObjectSeparator)} }`;
    } else {
      let result = '{\n';
      const indentation = `${inheritedIndentation}  `;
      let i = 0;

      for (const item of items) {
        if (i >= maxObjKeys) {
          result += `${indentation}... +${
            items.length - maxObjKeys
          } properties\n`;
          break;
        }

        result += `${indentation + item},\n`;
        i++;
      }

      result += `${inheritedIndentation}}`;

      return result;
    }
  }

  return JSON.stringify(value, null, 2);
}
