// A small, dependency-free byte-mode QR encoder for the broadcast access URL.
// Version 4-L holds up to 80 UTF-8 bytes, which is ample for a local HTTP URL.
const QR_VERSION = 4;
const QR_SIZE = 17 + QR_VERSION * 4;
const QR_DATA_CODEWORDS = 80;
const QR_ECC_CODEWORDS = 20;

function gfMultiply(left, right) {
  let result = 0;
  let a = left;
  let b = right;
  while (b > 0) {
    if (b & 1) result ^= a;
    b >>>= 1;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return result;
}

function qrGeneratorPolynomial(eccLength) {
  let generator = [1];
  let root = 1;
  for (let index = 0; index < eccLength; index += 1) {
    const next = Array(generator.length + 1).fill(0);
    generator.forEach((coefficient, coefficientIndex) => {
      next[coefficientIndex] ^= coefficient;
      next[coefficientIndex + 1] ^= gfMultiply(coefficient, root);
    });
    generator = next;
    root = gfMultiply(root, 2);
  }
  return generator;
}

function qrErrorCorrection(data, eccLength) {
  const generator = qrGeneratorPolynomial(eccLength);
  const remainder = Array(eccLength).fill(0);
  data.forEach(byte => {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[eccLength - 1] = 0;
    for (let index = 0; index < eccLength; index += 1) {
      remainder[index] ^= gfMultiply(generator[index + 1], factor);
    }
  });
  return remainder;
}

function qrMask(mask, row, column) {
  if (mask === 0) return (row + column) % 2 === 0;
  if (mask === 1) return row % 2 === 0;
  if (mask === 2) return column % 3 === 0;
  if (mask === 3) return (row + column) % 3 === 0;
  if (mask === 4) return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
  if (mask === 5) return (row * column) % 2 + (row * column) % 3 === 0;
  if (mask === 6) return ((row * column) % 2 + (row * column) % 3) % 2 === 0;
  return ((row * column) % 3 + (row + column) % 2) % 2 === 0;
}

function qrSetFunction(matrix, functions, x, y, value) {
  if (x < 0 || x >= QR_SIZE || y < 0 || y >= QR_SIZE) return;
  matrix[y][x] = Boolean(value);
  functions[y][x] = true;
}

function qrDrawFinder(matrix, functions, centerX, centerY) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      qrSetFunction(matrix, functions, centerX + dx - 3, centerY + dy - 3, dark);
    }
  }
}

function qrDrawAlignment(matrix, functions, centerX, centerY) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      qrSetFunction(matrix, functions, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function qrReserveFormat(functions) {
  for (let index = 0; index < 15; index += 1) {
    const vertical = index < 6 ? index : index < 8 ? index + 1 : QR_SIZE - 15 + index;
    const horizontal = index < 8 ? QR_SIZE - index - 1 : index < 9 ? 15 - index : 14 - index;
    functions[vertical][8] = true;
    functions[8][horizontal] = true;
  }
  functions[QR_SIZE - 8][8] = true;
}

function qrFormatBits(mask) {
  const data = (1 << 3) | mask; // Error correction level L is format value 01.
  let remainder = data << 10;
  const generator = 0x537;
  while (remainder >= 0x400) {
    remainder ^= generator << (Math.floor(Math.log2(remainder)) - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function qrDrawFormat(matrix, functions, mask) {
  const bits = qrFormatBits(mask);
  for (let index = 0; index < 15; index += 1) {
    const bit = ((bits >>> index) & 1) !== 0;
    const vertical = index < 6 ? index : index < 8 ? index + 1 : QR_SIZE - 15 + index;
    const horizontal = index < 8 ? QR_SIZE - index - 1 : index < 9 ? 15 - index : 14 - index;
    qrSetFunction(matrix, functions, 8, vertical, bit);
    qrSetFunction(matrix, functions, horizontal, 8, bit);
  }
  qrSetFunction(matrix, functions, 8, QR_SIZE - 8, true);
}

function qrDrawCodewords(matrix, functions, codewords) {
  let bitIndex = 0;
  let upward = true;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let offset = 0; offset < QR_SIZE; offset += 1) {
      const row = upward ? QR_SIZE - 1 - offset : offset;
      for (let side = 0; side < 2; side += 1) {
        const column = right - side;
        if (functions[row][column]) continue;
        matrix[row][column] = bitIndex < codewords.length * 8
          ? ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0
          : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  if (bitIndex < codewords.length * 8) throw new Error('QR 데이터 배치에 실패했습니다.');
}

function qrPenalty(matrix) {
  let penalty = 0;
  const size = matrix.length;
  for (let row = 0; row < size; row += 1) {
    let runColor = matrix[row][0];
    let runLength = 1;
    for (let column = 1; column <= size; column += 1) {
      if (column < size && matrix[row][column] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += 3 + runLength - 5;
        if (column < size) { runColor = matrix[row][column]; runLength = 1; }
      }
    }
  }
  for (let column = 0; column < size; column += 1) {
    let runColor = matrix[0][column];
    let runLength = 1;
    for (let row = 1; row <= size; row += 1) {
      if (row < size && matrix[row][column] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += 3 + runLength - 5;
        if (row < size) { runColor = matrix[row][column]; runLength = 1; }
      }
    }
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = matrix[row][column];
      if (matrix[row][column + 1] === value && matrix[row + 1][column] === value && matrix[row + 1][column + 1] === value) penalty += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= size - pattern.length; column += 1) {
      if (!pattern.every((value, index) => matrix[row][column + index] === value)) continue;
      const before = column >= 4 && matrix[row].slice(column - 4, column).every(value => !value);
      const after = column + 11 <= size && matrix[row].slice(column + 7, column + 11).every(value => !value);
      if (before || after) penalty += 40;
    }
  }
  for (let column = 0; column < size; column += 1) {
    for (let row = 0; row <= size - pattern.length; row += 1) {
      if (!pattern.every((value, index) => matrix[row + index][column] === value)) continue;
      let before = row >= 4;
      for (let index = 1; before && index <= 4; index += 1) before = !matrix[row - index][column];
      let after = row + 11 <= size;
      for (let index = 7; after && index <= 10; index += 1) after = !matrix[row + index][column];
      if (before || after) penalty += 40;
    }
  }
  let dark = 0;
  matrix.forEach(line => line.forEach(value => { if (value) dark += 1; }));
  penalty += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return penalty;
}

export function makeQrCode(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const bits = [0, 1, 0, 0];
  for (let index = 7; index >= 0; index -= 1) bits.push((payload.length >>> index) & 1);
  payload.forEach(byte => { for (let index = 7; index >= 0; index -= 1) bits.push((byte >>> index) & 1); });
  if (bits.length > QR_DATA_CODEWORDS * 8) throw new Error('브로드캐스트 URL이 QR 코드 용량을 초과합니다.');
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let index = 0; index < bits.length; index += 8) data.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
  let pad = 0xec;
  while (data.length < QR_DATA_CODEWORDS) { data.push(pad); pad ^= 0xfd; }
  const codewords = data.concat(qrErrorCorrection(data, QR_ECC_CODEWORDS));
  const matrix = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(null));
  const functions = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
  qrDrawFinder(matrix, functions, 3, 3);
  qrDrawFinder(matrix, functions, QR_SIZE - 4, 3);
  qrDrawFinder(matrix, functions, 3, QR_SIZE - 4);
  [6, QR_SIZE - 7].forEach(centerY => [6, QR_SIZE - 7].forEach(centerX => {
    if (!functions[centerY][centerX]) qrDrawAlignment(matrix, functions, centerX, centerY);
  }));
  for (let index = 8; index < QR_SIZE - 8; index += 1) {
    if (!functions[6][index]) qrSetFunction(matrix, functions, index, 6, index % 2 === 0);
    if (!functions[index][6]) qrSetFunction(matrix, functions, 6, index, index % 2 === 0);
  }
  qrReserveFormat(functions);
  qrDrawCodewords(matrix, functions, codewords);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = matrix.map(line => line.slice());
    for (let row = 0; row < QR_SIZE; row += 1) {
      for (let column = 0; column < QR_SIZE; column += 1) {
        if (!functions[row][column]) candidate[row][column] = candidate[row][column] !== qrMask(mask, row, column);
      }
    }
    qrDrawFormat(candidate, functions, mask);
    const score = qrPenalty(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return { size: QR_SIZE, modules: best.flat().map(value => value ? '1' : '0').join('') };
}
