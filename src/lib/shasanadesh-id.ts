export interface ShasanadeshIdParts {
  sequence: number;
  departmentId: number;
  sectionId: number;
  year: number;
}

export function decodeShasanadeshId(encodedId: string): {
  encodedId: string;
  base64: string;
  decodedId: string;
  parts: ShasanadeshIdParts;
} {
  const base64 = decodeURIComponent(encodedId);
  const decodedId = Buffer.from(base64, "base64").toString("utf8");
  const rawParts = decodedId.split("#");

  if (rawParts.length !== 4) {
    throw new Error(`Invalid Shasanadesh id: ${encodedId} -> ${decodedId}`);
  }

  const values = rawParts.map((value) => Number.parseInt(value, 10));

  if (values.some((value) => !Number.isInteger(value))) {
    throw new Error(`Non-numeric Shasanadesh id: ${encodedId} -> ${decodedId}`);
  }

  const [sequence, departmentId, sectionId, year] = values;

  return {
    encodedId,
    base64,
    decodedId,
    parts: {
      sequence,
      departmentId,
      sectionId,
      year,
    },
  };
}

export function encodeShasanadeshId(parts: ShasanadeshIdParts): string {
  const decodedId = [
    parts.sequence,
    parts.departmentId,
    parts.sectionId,
    parts.year,
  ].join("#");

  return Buffer.from(decodedId, "utf8").toString("base64");
}

export function buildShasanadeshPdfUrl(encodedId: string): string {
  const base64 = decodeURIComponent(encodedId);

  return (
    "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=" +
    encodeURIComponent(base64)
  );
}
