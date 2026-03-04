"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ubicuoEngine = exports.UbicuoEngine = void 0;
const ubicuo_parser_1 = require("./ubicuo-parser");
const ubicuo_matcher_1 = require("./ubicuo-matcher");
class UbicuoEngine {
    static getTipo(confidence, hasMatch) {
        if (!hasMatch)
            return 'sin_match';
        if (confidence >= 0.9)
            return 'perfecto';
        if (confidence >= 0.7)
            return 'incierto';
        return 'sin_match';
    }
    static convertToProducto(match, seccionActual, index) {
        if (match.is_section) {
            return {
                id: `seccion-${index}`,
                tipo: 'seccion',
                texto_original: match.query,
                seccion: match.query,
                linea_numero: match.line_number
            };
        }
        const hasMatch = match.matched_id !== null;
        const tipo = this.getTipo(match.confidence, hasMatch);
        return {
            id: `prod-${match.matched_id || 'unknown'}-${index}`,
            tipo,
            texto_original: match.query,
            nombre_producto: match.matched_name || match.query,
            producto_id: match.matched_id || undefined,
            cantidad: match.quantity,
            unidad: match.unit,
            confianza: Math.round(match.confidence * 100),
            seccion: seccionActual,
            linea_numero: match.line_number
        };
    }
    static organizarPorSecciones(productos) {
        const secciones = [];
        let seccionActual = null;
        let seccionIndex = 0;
        for (const producto of productos) {
            if (producto.tipo === 'seccion') {
                seccionActual = {
                    id: `seccion-${seccionIndex++}`,
                    nombre: producto.seccion || 'Sin nombre',
                    productos: [],
                    seleccionada: true
                };
                secciones.push(seccionActual);
            }
            else {
                if (!seccionActual) {
                    seccionActual = {
                        id: `seccion-${seccionIndex++}`,
                        nombre: 'General',
                        productos: [],
                        seleccionada: true
                    };
                    secciones.push(seccionActual);
                }
                seccionActual.productos.push(producto);
            }
        }
        return secciones.filter(s => s.productos.length > 0);
    }
    static process(request) {
        try {
            const parseResult = ubicuo_parser_1.parser.parse(request.text);
            if (!parseResult.success || parseResult.items.length === 0) {
                return {
                    success: false,
                    productos: [],
                    secciones: [],
                    stats: {
                        total_detectados: 0,
                        perfectos: 0,
                        inciertos: 0,
                        sin_match: 0,
                        secciones: 0
                    }
                };
            }
            const matcher = (0, ubicuo_matcher_1.createMatcher)(request.products, request.learningDict || {}, request.threshold || 0.75);
            const matches = matcher.matchBatch(parseResult.items);
            let seccionActual = 'General';
            const productos = matches.map((match, index) => {
                if (match.is_section) {
                    seccionActual = match.query;
                }
                return this.convertToProducto(match, seccionActual, index);
            });
            const secciones = this.organizarPorSecciones(productos);
            const stats = {
                total_detectados: 0,
                perfectos: 0,
                inciertos: 0,
                sin_match: 0,
                secciones: secciones.length
            };
            for (let i = 0; i < productos.length; i++) {
                const tipo = productos[i].tipo;
                if (tipo === 'seccion')
                    continue;
                stats.total_detectados++;
                if (tipo === 'perfecto')
                    stats.perfectos++;
                else if (tipo === 'incierto')
                    stats.inciertos++;
                else if (tipo === 'sin_match')
                    stats.sin_match++;
            }
            return {
                success: true,
                productos,
                secciones,
                stats
            };
        }
        catch (error) {
            console.error('Error en UbicuoEngine:', error);
            return {
                success: false,
                productos: [],
                secciones: [],
                stats: {
                    total_detectados: 0,
                    perfectos: 0,
                    inciertos: 0,
                    sin_match: 0,
                    secciones: 0
                }
            };
        }
    }
    static parseOnly(text) {
        const result = ubicuo_parser_1.parser.parse(text);
        return result.items;
    }
}
exports.UbicuoEngine = UbicuoEngine;
exports.ubicuoEngine = UbicuoEngine;
