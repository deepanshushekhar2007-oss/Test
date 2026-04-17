export interface VCFContact {
  name: string;
  phone: string;
}

export function parseVCF(content: string): VCFContact[] {
  const contacts: VCFContact[] = [];
  const cards = content.split("BEGIN:VCARD");

  for (const card of cards) {
    if (!card.trim()) continue;

    let name = "";
    let phone = "";

    const lines = card.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("FN:") || line.startsWith("FN;")) {
        name = line.replace(/^FN[;:]/, "").trim();
      }
      if (line.startsWith("TEL") || line.startsWith("tel")) {
        const match = line.match(/:([\d\s+\-().]+)/);
        if (match) {
          phone = match[1].replace(/[\s\-().]/g, "").trim();
          if (!phone.startsWith("+")) {
            phone = "+" + phone;
          }
        }
      }
    }

    if (phone) {
      contacts.push({ name: name || "Unknown", phone });
    }
  }

  return contacts;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}
