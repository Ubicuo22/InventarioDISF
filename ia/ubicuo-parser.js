"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parser = void 0;
class UbicuoParser {
    constructor() {
        this.unitMap = {
            'KG': ['kilogramos', 'kilogramo', 'kilos', 'kilo', 'gramos', 'gramo', 'kgs', 'kg', 'kl', 'gr', 'k', 'g'],
            'PZ': ['unidades', 'unidad', 'piezas', 'pieza', 'pzas', 'pzs', 'pza', 'pz'],
            'MJO': ['manojos', 'manojo', 'mnjo', 'mjo'],
            'CAJA': ['charolas', 'charola', 'cajas', 'caja'],
            'LT': ['litros', 'litro', 'lt', 'l'],
            'PAQUETE': ['paquetes', 'paquete', 'pqte', 'paq'],
            'BOLSA': ['bolsas', 'bolsa'],
            'COSTAL': ['costales', 'costal', 'bultos', 'bulto'],
            'DOCENA': ['docenas', 'docena', 'dza', 'dz'],
            'METRO': ['metros', 'metro', 'mt', 'm'],
            'ROLLO': ['rollos', 'rollo'],
            'LATA': ['latas', 'lata'],
            'BOTE': ['botes', 'bote'],
            'GALON': ['galones', 'galón', 'galon']
        };
        this.sectionIndicators = [
            'frutas', 'verduras', 'lácteos', 'lacteos', 'carnes', 'abarrotes', 'bebidas',
            'limpieza', 'personal', 'panadería', 'congelados', 'enlatados',
            'especiales', 'varios', 'otros', 'semillas', 'granos', 'cereales',
            'desechables', 'pedido'
        ];
        const allUnits = Object.values(this.unitMap)
            .flat()
            .sort((a, b) => b.length - a.length);
        this.unitRegex = allUnits.join('|');
        this.patterns = [
            new RegExp(`^(\\d+(?:[.,/]\\d+)?)\\s*(${this.unitRegex})\\b\\s*(?:de\\s+|d\\s+)?(.+)`, 'i'),
            new RegExp(`^(.+?)\\s+(\\d+(?:[.,/]\\d+)?)\\s*(${this.unitRegex})$`, 'i'),
            /^(\d+(?:[.,]\d+)?)\s+(.+)$/,
            /^(.+?)\s+(\d+(?:[.,]\d+)?)$/,
            /^(.+)$/
        ];
    }
    isOnlyUnit(text) {
        const cleaned = text.toLowerCase().trim();
        for (const variants of Object.values(this.unitMap)) {
            if (variants.includes(cleaned)) {
                return true;
            }
        }
        return false;
    }
    isValidProductName(name) {
        const cleaned = name.trim();
        if (cleaned.length < 2) {
            return false;
        }
        if (/^\d+$/.test(cleaned)) {
            return false;
        }
        if (this.isOnlyUnit(cleaned)) {
            return false;
        }
        return true;
    }
    normalizeUnit(unit) {
        const unitLower = unit.toLowerCase().trim();
        for (const [normalized, variants] of Object.entries(this.unitMap)) {
            if (variants.includes(unitLower)) {
                return normalized;
            }
        }
        return 'PZ';
    }
    parseFraction(text) {
        text = text.replace(',', '.');
        if (text.includes('/')) {
            const [numerator, denominator] = text.split('/');
            const num = parseFloat(numerator);
            const den = parseFloat(denominator);
            if (!isNaN(num) && !isNaN(den) && den !== 0) {
                return num / den;
            }
        }
        return parseFloat(text);
    }
    convertGramsToKg(quantity, unit) {
        const unitLower = unit.toLowerCase().trim();
        if (['gr', 'g', 'gramos', 'gramo'].includes(unitLower)) {
            return {
                quantity: quantity / 1000,
                unit: 'KG'
            };
        }
        return {
            quantity,
            unit: this.normalizeUnit(unit)
        };
    }
    cleanProductName(name) {
        return name
            .replace(/\s+de\s+/gi, ' ')
            .replace(/\s+d\s+/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    isSection(line) {
        const cleaned = line.toLowerCase().trim();
        if (cleaned.endsWith(':'))
            return true;
        if (line === line.toUpperCase() && line.length < 30 && line.length > 2) {
            if (!/\d/.test(line))
                return true;
        }
        const firstWord = cleaned.split(/\s+/)[0];
        if (this.sectionIndicators.includes(firstWord))
            return true;
        return this.sectionIndicators.some(indicator => cleaned.includes(indicator) && cleaned.length < 40);
    }
    parseTabularLine(line, lineNumber) {
        if (!line.includes('\t'))
            return null;
        const cols = line.split('\t').map(c => c.trim()).filter(c => c.length > 0);
        if (cols.length < 2)
            return null;
        const cleanNum = (s) => {
            const cleaned = s.replace(/[$,]/g, '').trim();
            return parseFloat(cleaned);
        };
        const isProductCol = (s) => {
            const cleaned = s.replace(/[$,.\d\s]/g, '').trim();
            return cleaned.length >= 2 && !/^\d+$/.test(s.trim());
        };
        const isNumericCol = (s) => {
            const cleaned = s.replace(/[$,]/g, '').trim();
            return !isNaN(parseFloat(cleaned)) && cleaned.length > 0;
        };
        let productName = null;
        let quantity = 1;
        for (let i = 0; i < cols.length; i++) {
            if (isProductCol(cols[i]) && !productName) {
                productName = cols[i];
                if (i + 1 < cols.length && isNumericCol(cols[i + 1])) {
                    const q = cleanNum(cols[i + 1]);
                    if (q > 0 && q < 100000) {
                        quantity = q;
                    }
                }
                break;
            }
        }
        if (!productName && cols.length >= 3) {
            if (/^\d+$/.test(cols[0].trim()) && isProductCol(cols[1])) {
                productName = cols[1];
                if (isNumericCol(cols[2])) {
                    const q = cleanNum(cols[2]);
                    if (q > 0 && q < 100000) {
                        quantity = q;
                    }
                }
            }
        }
        if (!productName || !this.isValidProductName(productName))
            return null;
        const product = this.cleanProductName(productName);
        return {
            product_name: product,
            quantity,
            unit: 'PZ',
            original_text: line.trim(),
            line_number: lineNumber,
            is_section: false
        };
    }
    parseLine(line, lineNumber) {
        const trimmed = line.trim().replace(/^[*•\-–—]\s*/, '');
        if (!trimmed || trimmed.length < 2)
            return null;
        if (this.isOnlyUnit(trimmed)) {
            console.warn(`Línea ${lineNumber} rechazada: "${trimmed}" es solo una unidad de medida`);
            return null;
        }
        if (this.isSection(trimmed)) {
            return {
                product_name: trimmed.replace(/:$/, '').trim(),
                quantity: 0,
                unit: '',
                original_text: trimmed,
                line_number: lineNumber,
                is_section: true
            };
        }
        const tabularResult = this.parseTabularLine(trimmed, lineNumber);
        if (tabularResult)
            return tabularResult;
        let match;
        match = trimmed.match(this.patterns[0]);
        if (match) {
            const rawQuantity = this.parseFraction(match[1]);
            const rawUnit = match[2];
            const productRaw = match[3].trim();
            if (this.isValidProductName(productRaw)) {
                const { quantity, unit } = this.convertGramsToKg(rawQuantity, rawUnit);
                const product = this.cleanProductName(productRaw);
                if (product.length > 0) {
                    return {
                        product_name: product, quantity, unit,
                        original_text: trimmed, line_number: lineNumber, is_section: false
                    };
                }
            }
        }
        match = trimmed.match(this.patterns[1]);
        if (match) {
            const productRaw = match[1].trim();
            const rawQuantity = this.parseFraction(match[2]);
            const rawUnit = match[3];
            if (this.isValidProductName(productRaw)) {
                const { quantity, unit } = this.convertGramsToKg(rawQuantity, rawUnit);
                const product = this.cleanProductName(productRaw);
                if (product.length > 0) {
                    return {
                        product_name: product, quantity, unit,
                        original_text: trimmed, line_number: lineNumber, is_section: false
                    };
                }
            }
        }
        match = trimmed.match(this.patterns[2]);
        if (match) {
            const rawQuantity = this.parseFraction(match[1]);
            const productRaw = match[2]?.trim();
            if (!isNaN(rawQuantity) && productRaw && this.isValidProductName(productRaw)) {
                const product = this.cleanProductName(productRaw);
                return {
                    product_name: product, quantity: rawQuantity, unit: 'PZ',
                    original_text: trimmed, line_number: lineNumber, is_section: false
                };
            }
        }
        match = trimmed.match(this.patterns[3]);
        if (match) {
            const productRaw = match[1]?.trim();
            const rawQuantity = this.parseFraction(match[2]);
            if (!isNaN(rawQuantity) && rawQuantity > 0 && productRaw && this.isValidProductName(productRaw)) {
                const product = this.cleanProductName(productRaw);
                return {
                    product_name: product, quantity: rawQuantity, unit: 'PZ',
                    original_text: trimmed, line_number: lineNumber, is_section: false
                };
            }
        }
        match = trimmed.match(this.patterns[4]);
        if (match) {
            const productRaw = match[1].trim();
            if (this.isValidProductName(productRaw)) {
                const product = this.cleanProductName(productRaw);
                return {
                    product_name: product, quantity: 1, unit: 'PZ',
                    original_text: trimmed, line_number: lineNumber, is_section: false
                };
            }
        }
        return null;
    }
    parse(text) {
        const lines = text.split('\n');
        const items = [];
        const sections = new Set();
        const rejectedLines = [];
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && this.isOnlyUnit(trimmed)) {
                rejectedLines.push(`Línea ${i + 1}: "${trimmed}" (solo unidad)`);
            }
            const item = this.parseLine(lines[i], i + 1);
            if (item) {
                items.push(item);
                if (item.is_section) {
                    sections.add(item.product_name);
                }
            }
        }
        return {
            success: true,
            items,
            total_items: items.filter(i => !i.is_section).length,
            sections: Array.from(sections),
            rejected_lines: rejectedLines.length > 0 ? rejectedLines : undefined
        };
    }
}
exports.parser = new UbicuoParser();
