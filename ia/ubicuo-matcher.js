"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UbicuoMatcher = void 0;
exports.createMatcher = createMatcher;
class UbicuoMatcher {
    constructor(products, config) {
        this.productsMap = new Map();
        this.prefixIndex = new Map();
        this.wordIndex = new Map();
        products.forEach(p => {
            const normalized = this.normalize(p.nombre_producto);
            this.productsMap.set(normalized, p);
            if (normalized.length >= 3) {
                const prefix = normalized.substring(0, 3);
                if (!this.prefixIndex.has(prefix)) {
                    this.prefixIndex.set(prefix, []);
                }
                this.prefixIndex.get(prefix).push(p);
            }
            const words = normalized.split(' ');
            words.forEach(word => {
                if (word.length >= 3) {
                    if (!this.wordIndex.has(word)) {
                        this.wordIndex.set(word, new Set());
                    }
                    this.wordIndex.get(word).add(normalized);
                }
            });
        });
        this.learningDict = new Map();
        Object.entries(config.learningDict).forEach(([incorrect, correct]) => {
            this.learningDict.set(this.normalize(incorrect), this.normalize(correct));
        });
        this.threshold = config.threshold || 0.75;
    }
    normalize(text) {
        return text
            .toLowerCase()
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ');
    }
    similarity(s1, s2) {
        const len1 = s1.length;
        const len2 = s2.length;
        if (len1 === 0)
            return len2 === 0 ? 1 : 0;
        if (len2 === 0)
            return 0;
        const maxLen = Math.max(len1, len2);
        const minLen = Math.min(len1, len2);
        if (maxLen / minLen > 3)
            return 0;
        let prevRow = Array(len2 + 1).fill(0).map((_, i) => i);
        let currRow = Array(len2 + 1).fill(0);
        for (let i = 1; i <= len1; i++) {
            currRow[0] = i;
            for (let j = 1; j <= len2; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
                currRow[j] = Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + cost);
            }
            ;
            [prevRow, currRow] = [currRow, prevRow];
        }
        const distance = prevRow[len2];
        const sim = 1 - (distance / maxLen);
        return sim;
    }
    advancedSimilarity(query, candidate) {
        const q = this.normalize(query);
        const c = this.normalize(candidate);
        let score = this.similarity(q, c);
        const qWords = new Set(q.split(' '));
        const cWords = new Set(c.split(' '));
        const commonWords = [...qWords].filter(w => cWords.has(w)).length;
        const maxWords = Math.max(qWords.size, cWords.size);
        if (maxWords > 0) {
            const wordBonus = (commonWords / maxWords) * 0.2;
            score = Math.min(1, score + wordBonus);
        }
        const minLength = Math.min(q.length, c.length);
        let matchingPrefix = 0;
        for (let i = 0; i < minLength; i++) {
            if (q[i] === c[i])
                matchingPrefix++;
            else
                break;
        }
        if (matchingPrefix >= 3) {
            const prefixBonus = (matchingPrefix / minLength) * 0.15;
            score = Math.min(1, score + prefixBonus);
        }
        const lengthRatio = minLength / Math.max(q.length, c.length);
        if (lengthRatio > 0.8) {
            score = Math.min(1, score + 0.05);
        }
        return score;
    }
    getCandidates(query) {
        const normalized = this.normalize(query);
        const candidateNames = new Set();
        if (normalized.length >= 3) {
            const prefix = normalized.substring(0, 3);
            const prefixMatches = this.prefixIndex.get(prefix);
            if (prefixMatches) {
                prefixMatches.forEach(p => candidateNames.add(this.normalize(p.nombre_producto)));
            }
        }
        const queryWords = normalized.split(' ');
        queryWords.forEach(word => {
            if (word.length >= 3) {
                const wordMatches = this.wordIndex.get(word);
                if (wordMatches) {
                    wordMatches.forEach(name => candidateNames.add(name));
                }
            }
        });
        if (candidateNames.size >= 2) {
            return Array.from(candidateNames)
                .map(name => this.productsMap.get(name))
                .filter((p) => p !== undefined);
        }
        return Array.from(this.productsMap.values());
    }
    findBestMatch(query) {
        const candidates = this.getCandidates(query);
        let bestMatch = null;
        let bestScore = 0;
        for (const product of candidates) {
            const normalizedName = this.normalize(product.nombre_producto);
            const score = this.advancedSimilarity(query, normalizedName);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = product;
            }
        }
        if ((!bestMatch || bestScore < this.threshold) && candidates.length < this.productsMap.size) {
            for (const [normalizedName, product] of this.productsMap.entries()) {
                const score = this.advancedSimilarity(query, normalizedName);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = product;
                }
            }
        }
        return bestMatch && bestScore >= this.threshold
            ? { product: bestMatch, score: bestScore }
            : null;
    }
    matchItem(item) {
        if (item.is_section) {
            return {
                query: item.product_name,
                quantity: 0,
                unit: '',
                matched_id: null,
                matched_name: item.product_name,
                confidence: 1.0,
                method: 'exact',
                line_number: item.line_number,
                is_section: true
            };
        }
        const queryNormalized = this.normalize(item.product_name);
        if (this.productsMap.has(queryNormalized)) {
            const product = this.productsMap.get(queryNormalized);
            return {
                query: item.product_name,
                quantity: item.quantity,
                unit: item.unit,
                matched_id: product.id_producto,
                matched_name: product.nombre_producto,
                confidence: 1.0,
                method: 'exact',
                line_number: item.line_number
            };
        }
        if (this.learningDict.has(queryNormalized)) {
            const corrected = this.learningDict.get(queryNormalized);
            if (this.productsMap.has(corrected)) {
                const product = this.productsMap.get(corrected);
                return {
                    query: item.product_name,
                    quantity: item.quantity,
                    unit: item.unit,
                    matched_id: product.id_producto,
                    matched_name: product.nombre_producto,
                    confidence: 0.95,
                    method: 'learned',
                    line_number: item.line_number
                };
            }
        }
        const fuzzyMatch = this.findBestMatch(queryNormalized);
        if (fuzzyMatch) {
            return {
                query: item.product_name,
                quantity: item.quantity,
                unit: item.unit,
                matched_id: fuzzyMatch.product.id_producto,
                matched_name: fuzzyMatch.product.nombre_producto,
                confidence: fuzzyMatch.score,
                method: 'fuzzy',
                line_number: item.line_number
            };
        }
        return {
            query: item.product_name,
            quantity: item.quantity,
            unit: item.unit,
            matched_id: null,
            matched_name: null,
            confidence: 0,
            method: 'none',
            line_number: item.line_number
        };
    }
    matchBatch(items) {
        return items.map(item => this.matchItem(item));
    }
}
exports.UbicuoMatcher = UbicuoMatcher;
function createMatcher(products, learningDict = {}, threshold = 0.75) {
    return new UbicuoMatcher(products, { threshold, learningDict });
}
