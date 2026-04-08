/**
 * Comprehensive mapping of Uruguay cities/localities to their departments.
 * For use in shipping systems, address validation, and logistics.
 *
 * Keys: lowercase city/locality name, without accents.
 * Values: official department name, properly capitalized.
 *
 * Uruguay has 19 departments. Each department capital is included,
 * plus cities/towns with 1000+ population and commonly known localities.
 *
 * Sources: INE (Instituto Nacional de Estadistica) census data,
 * Uruguay postal system (Correo Uruguayo).
 */

export const CITY_TO_DEPARTMENT: Record<string, string> = {
  // ─────────────────────────────────────────────
  // ARTIGAS (capital: Artigas)
  // ─────────────────────────────────────────────
  'artigas': 'Artigas',
  'bella union': 'Artigas',
  'tomas gomensoro': 'Artigas',
  'baltasar brum': 'Artigas',
  'bernabe rivera': 'Artigas',
  'sequeira': 'Artigas',
  'javier de viana': 'Artigas',
  'pintadito': 'Artigas',
  'topador': 'Artigas',
  'cuareim': 'Artigas',
  'paso campamento': 'Artigas',
  'franquia': 'Artigas',
  'cainsa': 'Artigas',
  'colonia palma': 'Artigas',
  'cerro signorelli': 'Artigas',
  'paso farias': 'Artigas',

  // ─────────────────────────────────────────────
  // CANELONES (capital: Canelones)
  // ─────────────────────────────────────────────
  'canelones': 'Canelones',
  'las piedras': 'Canelones',
  'ciudad de la costa': 'Canelones',
  'pando': 'Canelones',
  'la paz': 'Canelones',
  'progreso': 'Canelones',
  'santa lucia': 'Canelones',
  'sauce': 'Canelones',
  'toledo': 'Canelones',
  'barros blancos': 'Canelones',
  'san ramon': 'Canelones',
  'san jacinto': 'Canelones',
  'san bautista': 'Canelones',
  'san antonio': 'Canelones',
  'empalme olmos': 'Canelones',
  'joaquin suarez': 'Canelones',
  'paso carrasco': 'Canelones',
  'colonia nicolich': 'Canelones',
  'migues': 'Canelones',
  'tala': 'Canelones',
  'soca': 'Canelones',
  'los cerrillos': 'Canelones',
  'montes': 'Canelones',
  'atlantida': 'Canelones',
  'parque del plata': 'Canelones',
  'salinas': 'Canelones',
  'marindia': 'Canelones',
  'la floresta': 'Canelones',
  'costa azul': 'Canelones',
  'neptunia': 'Canelones',
  'pinamar': 'Canelones',
  'las toscas': 'Canelones',
  'santa rosa': 'Canelones',
  'aguas corrientes': 'Canelones',
  'juanico': 'Canelones',
  'los titanes': 'Canelones',
  'suarez': 'Canelones',
  'villa aeroparque': 'Canelones',
  'solymar': 'Canelones',
  'shangri-la': 'Canelones',
  'lagomar': 'Canelones',
  'el pinar': 'Canelones',
  'lomas de solymar': 'Canelones',
  'villa el tato': 'Canelones',
  'colinas de solymar': 'Canelones',
  'aeropuerto de carrasco': 'Canelones',
  'barra de carrasco': 'Canelones',
  'san jose de carrasco': 'Canelones',
  'villa hadita': 'Canelones',
  'la estanzuela': 'Canelones',
  'totoral del sauce': 'Canelones',
  'santa ana': 'Canelones',
  'piedras de afilar': 'Canelones',
  'station atlantida': 'Canelones',
  'las brujas': 'Canelones',

  // ─────────────────────────────────────────────
  // CERRO LARGO (capital: Melo)
  // ─────────────────────────────────────────────
  'melo': 'Cerro Largo',
  'rio branco': 'Cerro Largo',
  'fraile muerto': 'Cerro Largo',
  'tupambae': 'Cerro Largo',
  'isidoro noblia': 'Cerro Largo',
  'acegua': 'Cerro Largo',
  'nando': 'Cerro Largo',
  'ramon trigo': 'Cerro Largo',
  'placido rosas': 'Cerro Largo',
  'centurion': 'Cerro Largo',
  'arevalo': 'Cerro Largo',
  'lago merin': 'Cerro Largo',
  'paso de los toros de cerro largo': 'Cerro Largo',
  'arbolito': 'Cerro Largo',
  'hipodromo': 'Cerro Largo',

  // ─────────────────────────────────────────────
  // COLONIA (capital: Colonia del Sacramento)
  // ─────────────────────────────────────────────
  'colonia del sacramento': 'Colonia',
  'colonia': 'Colonia',
  'carmelo': 'Colonia',
  'nueva helvecia': 'Colonia',
  'nueva palmira': 'Colonia',
  'juan lacaze': 'Colonia',
  'rosario': 'Colonia',
  'tarariras': 'Colonia',
  'ombues de lavalle': 'Colonia',
  'florencio sanchez': 'Colonia',
  'conchillas': 'Colonia',
  'colonia valdense': 'Colonia',
  'miguelete': 'Colonia',
  'la paz de colonia': 'Colonia',
  'cufre': 'Colonia',
  'barker': 'Colonia',
  'la estanzuela de colonia': 'Colonia',
  'el semillero': 'Colonia',
  'campana': 'Colonia',
  'real de san carlos': 'Colonia',
  'colonia cosmopolita': 'Colonia',
  'colonia suiza': 'Colonia',
  'riachuelo': 'Colonia',
  'martin chico': 'Colonia',
  'agraciada': 'Colonia',
  'la paz colonia': 'Colonia',
  'playa fomento': 'Colonia',

  // ─────────────────────────────────────────────
  // DURAZNO (capital: Durazno)
  // ─────────────────────────────────────────────
  'durazno': 'Durazno',
  'sarandi del yi': 'Durazno',
  'carmen': 'Durazno',
  'villa del carmen': 'Durazno',
  'blanquillo': 'Durazno',
  'santa bernardina': 'Durazno',
  'la paloma durazno': 'Durazno',
  'centenario': 'Durazno',
  'carlos reyles': 'Durazno',
  'aguas buenas': 'Durazno',
  'cerro chato': 'Durazno',
  'baygorria': 'Durazno',
  'pueblo de alvarez': 'Durazno',
  'feliciano': 'Durazno',

  // ─────────────────────────────────────────────
  // FLORES (capital: Trinidad)
  // ─────────────────────────────────────────────
  'trinidad': 'Flores',
  'ismael cortinas': 'Flores',
  'andresito': 'Flores',
  'la casilla': 'Flores',
  'juan jose castro': 'Flores',

  // ─────────────────────────────────────────────
  // FLORIDA (capital: Florida)
  // ─────────────────────────────────────────────
  'florida': 'Florida',
  'sarandi grande': 'Florida',
  'sarandi del yi florida': 'Florida',
  'casupa': 'Florida',
  'fray marcos': 'Florida',
  'veinticinco de mayo': 'Florida',
  '25 de mayo': 'Florida',
  'cardal': 'Florida',
  'veinticinco de agosto': 'Florida',
  '25 de agosto': 'Florida',
  'mendoza': 'Florida',
  'mendoza chico': 'Florida',
  'reboledo': 'Florida',
  'chamizo': 'Florida',
  'illescas': 'Florida',
  'la cruz florida': 'Florida',
  'alejandro gallinal': 'Florida',
  'nico perez': 'Florida',
  'la macana': 'Florida',
  'goni': 'Florida',
  'cerro colorado florida': 'Florida',
  'capilla del sauce': 'Florida',

  // ─────────────────────────────────────────────
  // LAVALLEJA (capital: Minas)
  // ─────────────────────────────────────────────
  'minas': 'Lavalleja',
  'jose pedro varela': 'Lavalleja',
  'solis de mataojo': 'Lavalleja',
  'mariscala': 'Lavalleja',
  'piraraja': 'Lavalleja',
  'zapican': 'Lavalleja',
  'jose batlle y ordonez': 'Lavalleja',
  'villa serrana': 'Lavalleja',
  'polanco del yi': 'Lavalleja',
  'gaetan': 'Lavalleja',
  'colon lavalleja': 'Lavalleja',

  // ─────────────────────────────────────────────
  // MALDONADO (capital: Maldonado)
  // ─────────────────────────────────────────────
  'maldonado': 'Maldonado',
  'punta del este': 'Maldonado',
  'san carlos': 'Maldonado',
  'piriapolis': 'Maldonado',
  'pan de azucar': 'Maldonado',
  'aigua': 'Maldonado',
  'garzon': 'Maldonado',
  'jose ignacio': 'Maldonado',
  'la barra': 'Maldonado',
  'manantiales': 'Maldonado',
  'balneario buenos aires': 'Maldonado',
  'ocean park': 'Maldonado',
  'chihuahua': 'Maldonado',
  'cerro pelado': 'Maldonado',
  'pueblo eden': 'Maldonado',
  'solis grande': 'Maldonado',
  'gregorio aznarez': 'Maldonado',
  'nueva carrara': 'Maldonado',
  'pueblo los pinos': 'Maldonado',
  'pinares': 'Maldonado',
  'punta ballena': 'Maldonado',
  'portezuelo': 'Maldonado',
  'el tesoro': 'Maldonado',
  'playa verde': 'Maldonado',
  'pueblo garzon': 'Maldonado',
  'playa hermosa': 'Maldonado',

  // ─────────────────────────────────────────────
  // MONTEVIDEO (capital: Montevideo)
  // ─────────────────────────────────────────────
  'montevideo': 'Montevideo',
  'santiago vazquez': 'Montevideo',
  'abayuba': 'Montevideo',
  'pajas blancas': 'Montevideo',
  'manga': 'Montevideo',
  'penarol': 'Montevideo',
  'colon': 'Montevideo',
  'cerro': 'Montevideo',
  'la teja': 'Montevideo',
  'pocitos': 'Montevideo',
  'punta carretas': 'Montevideo',
  'buceo': 'Montevideo',
  'malvin': 'Montevideo',
  'carrasco': 'Montevideo',
  'prado': 'Montevideo',
  'union': 'Montevideo',
  'la blanqueada': 'Montevideo',
  'tres cruces': 'Montevideo',
  'sayago': 'Montevideo',
  'belvedere': 'Montevideo',
  'nuevo paris': 'Montevideo',
  'ciudad vieja': 'Montevideo',
  'centro': 'Montevideo',
  'cordon': 'Montevideo',
  'palermo': 'Montevideo',
  'parque batlle': 'Montevideo',
  'parque rodo': 'Montevideo',
  'villa dolores': 'Montevideo',
  'maronas': 'Montevideo',
  'villa espanola': 'Montevideo',
  'la comercial': 'Montevideo',
  'aguada': 'Montevideo',
  'capurro': 'Montevideo',
  'goes': 'Montevideo',
  'jacinto vera': 'Montevideo',
  'reducto': 'Montevideo',
  'brazo oriental': 'Montevideo',
  'atahualpa': 'Montevideo',
  'casavalle': 'Montevideo',
  'piedras blancas': 'Montevideo',
  'jardines del hipodromo': 'Montevideo',
  'las acacias': 'Montevideo',
  'punta gorda': 'Montevideo',
  'malvin norte': 'Montevideo',
  'la paloma montevideo': 'Montevideo',
  'casabo': 'Montevideo',
  'paso de la arena': 'Montevideo',
  'lezica': 'Montevideo',
  'melilla': 'Montevideo',
  'villa garcia': 'Montevideo',

  // ─────────────────────────────────────────────
  // PAYSANDU (capital: Paysandu)
  // ─────────────────────────────────────────────
  'paysandu': 'Paysandu',
  'guichon': 'Paysandu',
  'quebracho': 'Paysandu',
  'san felix': 'Paysandu',
  'lorenzo geyres': 'Paysandu',
  'porvenir': 'Paysandu',
  'tambores': 'Paysandu',
  'piedras coloradas': 'Paysandu',
  'chapicuy': 'Paysandu',
  'termas de guaviyu': 'Paysandu',
  'gallinal': 'Paysandu',
  'beisso': 'Paysandu',
  'esperanza': 'Paysandu',
  'merinos': 'Paysandu',
  'canada del pueblo': 'Paysandu',
  'nuevo paysandu': 'Paysandu',
  'termas de almiron': 'Paysandu',
  'casablanca paysandu': 'Paysandu',

  // ─────────────────────────────────────────────
  // RIO NEGRO (capital: Fray Bentos)
  // ─────────────────────────────────────────────
  'fray bentos': 'Rio Negro',
  'young': 'Rio Negro',
  'nuevo berlin': 'Rio Negro',
  'san javier': 'Rio Negro',
  'paso de los toros rio negro': 'Rio Negro',
  'tres quintas': 'Rio Negro',
  'bellaco': 'Rio Negro',
  'grecco': 'Rio Negro',
  'menafra': 'Rio Negro',
  'sarandi de navarro': 'Rio Negro',
  'algorta': 'Rio Negro',
  'paso de la cruz': 'Rio Negro',
  'villa general borges': 'Rio Negro',
  'villa maria': 'Rio Negro',

  // ─────────────────────────────────────────────
  // RIVERA (capital: Rivera)
  // ─────────────────────────────────────────────
  'rivera': 'Rivera',
  'tranqueras': 'Rivera',
  'vichadero': 'Rivera',
  'minas de corrales': 'Rivera',
  'paso ataque': 'Rivera',
  'masoller': 'Rivera',
  'lapuente': 'Rivera',
  'moirones': 'Rivera',
  'cerro pelado rivera': 'Rivera',
  'santa teresa': 'Rivera',
  'mandubi': 'Rivera',
  'la pedrera rivera': 'Rivera',
  'amarillo': 'Rivera',
  'cerros de la calera': 'Rivera',
  'paso hospital': 'Rivera',

  // ─────────────────────────────────────────────
  // ROCHA (capital: Rocha)
  // ─────────────────────────────────────────────
  'rocha': 'Rocha',
  'chuy': 'Rocha',
  'castillos': 'Rocha',
  'lascano': 'Rocha',
  'la paloma': 'Rocha',
  'la pedrera': 'Rocha',
  'cabo polonio': 'Rocha',
  'velazquez': 'Rocha',
  'cebollati': 'Rocha',
  'dieciocho de julio': 'Rocha',
  '18 de julio': 'Rocha',
  'san luis al medio': 'Rocha',
  'aguas dulces': 'Rocha',
  'punta del diablo': 'Rocha',
  'barra de valizas': 'Rocha',
  'la coronilla': 'Rocha',
  'san miguel rocha': 'Rocha',
  'la aguada': 'Rocha',
  'pueblo nuevo rocha': 'Rocha',
  'oceania del polonio': 'Rocha',
  'la esmeralda': 'Rocha',
  'puimayen': 'Rocha',

  // ─────────────────────────────────────────────
  // SALTO (capital: Salto)
  // ─────────────────────────────────────────────
  'salto': 'Salto',
  'constitucion': 'Salto',
  'belen': 'Salto',
  'san antonio salto': 'Salto',
  'termas del dayman': 'Salto',
  'termas del arapey': 'Salto',
  'villa constitucion': 'Salto',
  'colonia lavalleja': 'Salto',
  'pueblo fernandez': 'Salto',
  'rincon de valentin': 'Salto',
  'pueblo celeste': 'Salto',
  'saucedo': 'Salto',
  'puntas de valentin': 'Salto',
  'colonia 18 de julio': 'Salto',
  'colonia itapebi': 'Salto',
  'arapey': 'Salto',
  'campo de todos': 'Salto',
  'laureles salto': 'Salto',
  'paso del parque': 'Salto',
  'dayman': 'Salto',

  // ─────────────────────────────────────────────
  // SAN JOSE (capital: San Jose de Mayo)
  // ─────────────────────────────────────────────
  'san jose de mayo': 'San Jose',
  'san jose': 'San Jose',
  'ciudad del plata': 'San Jose',
  'libertad': 'San Jose',
  'ecilda paullier': 'San Jose',
  'rodriguez': 'San Jose',
  'rafael perazza': 'San Jose',
  'delta del tigre': 'San Jose',
  'gonzalez': 'San Jose',
  'mal abrigo': 'San Jose',
  'puntas de valdez': 'San Jose',
  'kiyu': 'San Jose',
  'rincon del pino': 'San Jose',
  'playa pascual': 'San Jose',
  'pueblo nuevo san jose': 'San Jose',
  'canada grande': 'San Jose',
  'ituzaingo san jose': 'San Jose',
  'la boyada': 'San Jose',
  'villa maria san jose': 'San Jose',
  'raigon': 'San Jose',
  'scavino': 'San Jose',
  'juan soler': 'San Jose',
  'safici': 'San Jose',

  // ─────────────────────────────────────────────
  // SORIANO (capital: Mercedes)
  // ─────────────────────────────────────────────
  'mercedes': 'Soriano',
  'dolores': 'Soriano',
  'cardona': 'Soriano',
  'jose enrique rodo': 'Soriano',
  'palmitas': 'Soriano',
  'villa soriano': 'Soriano',
  'risso': 'Soriano',
  'santa catalina': 'Soriano',
  'agraciada soriano': 'Soriano',
  'egana': 'Soriano',
  'canada nieto': 'Soriano',
  'perseverano': 'Soriano',
  'chacras de dolores': 'Soriano',
  'sacachispas': 'Soriano',
  'colonia concordia': 'Soriano',

  // ─────────────────────────────────────────────
  // TACUAREMBO (capital: Tacuarembo)
  // ─────────────────────────────────────────────
  'tacuarembo': 'Tacuarembo',
  'paso de los toros': 'Tacuarembo',
  'san gregorio de polanco': 'Tacuarembo',
  'ansina': 'Tacuarembo',
  'curtina': 'Tacuarembo',
  'achar': 'Tacuarembo',
  'caraguata': 'Tacuarembo',
  'cuchilla de peralta': 'Tacuarembo',
  'rincon de la torre': 'Tacuarembo',
  'paso del cerro': 'Tacuarembo',
  'tambores tacuarembo': 'Tacuarembo',
  'las toscas tacuarembo': 'Tacuarembo',
  'pueblo de arriba': 'Tacuarembo',
  'paso bonito': 'Tacuarembo',
  'pueblo del barro': 'Tacuarembo',
  'cuchilla del ombu': 'Tacuarembo',
  'puntas de cinco sauces': 'Tacuarembo',
  'clara': 'Tacuarembo',
  'laureles': 'Tacuarembo',
  'la hilera': 'Tacuarembo',
  'valle eden': 'Tacuarembo',
  'rincon del bonete': 'Tacuarembo',
  'peralta': 'Tacuarembo',
  'balneario ipora': 'Tacuarembo',

  // ─────────────────────────────────────────────
  // TREINTA Y TRES (capital: Treinta y Tres)
  // ─────────────────────────────────────────────
  'treinta y tres': 'Treinta y Tres',
  'vergara': 'Treinta y Tres',
  'santa clara de olimar': 'Treinta y Tres',
  'cerro chato treinta y tres': 'Treinta y Tres',
  'villa sara': 'Treinta y Tres',
  'rincon': 'Treinta y Tres',
  'ejido de treinta y tres': 'Treinta y Tres',
  'isla patrulla': 'Treinta y Tres',
  'maria albina': 'Treinta y Tres',
  'puntas del yerbal': 'Treinta y Tres',
  'valentines': 'Treinta y Tres',
  'poblado arrocero': 'Treinta y Tres',
  'general enrique martinez': 'Treinta y Tres',
  'charqueada': 'Treinta y Tres',
  'arrozal treinta y tres': 'Treinta y Tres',
};

/**
 * Helper: all 19 departments of Uruguay.
 */
export const DEPARTMENTS = [
  'Artigas',
  'Canelones',
  'Cerro Largo',
  'Colonia',
  'Durazno',
  'Flores',
  'Florida',
  'Lavalleja',
  'Maldonado',
  'Montevideo',
  'Paysandu',
  'Rio Negro',
  'Rivera',
  'Rocha',
  'Salto',
  'San Jose',
  'Soriano',
  'Tacuarembo',
  'Treinta y Tres',
] as const;

export type Department = typeof DEPARTMENTS[number];

/**
 * Reverse lookup: get all cities for a given department.
 */
export function getCitiesByDepartment(department: string): string[] {
  return Object.entries(CITY_TO_DEPARTMENT)
    .filter(([_, dept]) => dept.toLowerCase() === department.toLowerCase())
    .map(([city]) => city);
}

/**
 * Look up the department for a city name.
 * Normalizes input: trims, lowercases, strips accents.
 */
export function getDepartmentForCity(cityName: string): string | undefined {
  const normalized = cityName
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, ' ')      // "La.paz" → "La paz"
    .replace(/\s+/g, ' ')      // collapse multiple spaces
    .trim();
  return CITY_TO_DEPARTMENT[normalized];
}

// ── ZIP Code → Barrio mapping (Montevideo) ──

/**
 * Maps Montevideo ZIP code prefixes (first 3-5 digits) to candidate barrios.
 * Keys are normalized to the nearest hundred for broad matching.
 * Barrio names are lowercase, matching MONTEVIDEO_BARRIO_ALIASES keys in shipment.ts.
 */
export const MONTEVIDEO_ZIP_TO_BARRIOS: Record<string, string[]> = {
  '11000': ['ciudad vieja', 'centro'],
  '11100': ['centro', 'cordon', 'barrio sur'],
  '11200': ['cordon', 'parque rodo', 'palermo'],
  '11300': ['tres cruces', 'la comercial', 'la figurita', 'jacinto vera'],
  '11400': ['la blanqueada', 'goes', 'reducto', 'brazo oriental'],
  '11500': ['pocitos', 'punta carretas', 'parque batlle'],
  '11600': ['buceo', 'malvin', 'malvin norte'],
  '11700': ['union', 'maronas', 'flor de maronas', 'las canteras'],
  '11800': ['carrasco', 'carrasco norte', 'punta gorda'],
  '11900': ['cerro', 'la teja', 'paso de la arena', 'casabo'],
  '12000': ['colon', 'lezica', 'sayago'],
  '12100': ['prado', 'capurro', 'belvedere', 'nuevo paris'],
  '12200': ['aires puros', 'casavalle', 'piedras blancas'],
  '12300': ['manga', 'punta de rieles', 'villa garcia'],
  '12400': ['atahualpa', 'mercado modelo', 'villa dolores'],
  '12500': ['aguada'],
  '12600': ['pocitos nuevo', 'villa española'],
  '12700': ['tres ombues', 'villa muñoz'],
  '12800': ['cerrito'],
};

/**
 * Maps first 2 digits of Uruguayan ZIP to department name.
 */
export const DEPARTMENT_ZIP_PREFIX: Record<string, string> = {
  '11': 'Montevideo',
  '12': 'Montevideo',
  '15': 'Canelones',
  '16': 'Canelones',
  '17': 'Canelones',
  '20': 'Maldonado',
  '21': 'Maldonado',
  '25': 'Rocha',
  '27': 'Treinta y Tres',
  '30': 'Cerro Largo',
  '33': 'Rivera',
  '35': 'Artigas',
  '37': 'Salto',
  '40': 'Paysandu',
  '45': 'Rio Negro',
  '47': 'Soriano',
  '50': 'Colonia',
  '60': 'San Jose',
  '65': 'Flores',
  '70': 'Florida',
  '75': 'Durazno',
  '80': 'Lavalleja',
  '85': 'Tacuarembo',
  '90': 'Treinta y Tres',
  '91': 'Cerro Largo',
};

/**
 * Maps major Montevideo street/avenue names to candidate barrios.
 * Keys are lowercase, accent-stripped fragments to match against address1.
 */
export const MONTEVIDEO_STREET_TO_BARRIOS: Record<string, string[]> = {
  '18 de julio': ['centro', 'cordon', 'tres cruces'],
  'bvar artigas': ['tres cruces', 'parque batlle', 'goes'],
  'boulevard artigas': ['tres cruces', 'parque batlle', 'goes'],
  'av italia': ['buceo', 'union', 'malvin', 'malvin norte'],
  'avenida italia': ['buceo', 'union', 'malvin', 'malvin norte'],
  'rambla': ['ciudad vieja', 'centro', 'palermo', 'parque rodo', 'pocitos', 'punta carretas', 'buceo', 'malvin', 'punta gorda', 'carrasco'],
  '8 de octubre': ['goes', 'union', 'la blanqueada', 'malvin norte'],
  'av rivera': ['pocitos', 'buceo', 'parque batlle'],
  'avenida rivera': ['pocitos', 'buceo', 'parque batlle'],
  'camino maldonado': ['union', 'maronas', 'manga'],
  'millan': ['la blanqueada', 'reducto', 'prado', 'la teja'],
  'av millan': ['reducto', 'prado', 'la teja'],
  'avenida millan': ['reducto', 'prado', 'la teja'],
  'general flores': ['goes', 'sayago', 'colon', 'belvedere'],
  'gral flores': ['goes', 'sayago', 'colon', 'belvedere'],
  'camino carrasco': ['carrasco', 'carrasco norte', 'punta gorda'],
  'luis a de herrera': ['la blanqueada', 'tres cruces', 'parque batlle'],
  'herrera y obes': ['centro', 'cordon'],
  'camino centenario': ['aires puros', 'casavalle'],
  'bvar batlle y ordonez': ['goes', 'union', 'flor de maronas'],
  'av agraciada': ['aguada', 'goes', 'reducto'],
  'avenida agraciada': ['aguada', 'goes', 'reducto'],
  'constituyente': ['cordon', 'parque rodo', 'pocitos'],
  'bvar espana': ['parque rodo', 'pocitos', 'punta carretas'],
  'boulevard espana': ['parque rodo', 'pocitos', 'punta carretas'],
  '21 de setiembre': ['pocitos', 'punta carretas'],
  'ellauri': ['pocitos', 'punta carretas'],
  'av brasil': ['pocitos', 'buceo'],
  'avenida brasil': ['pocitos', 'buceo'],
  'dr luis piera': ['parque rodo', 'palermo'],
  'av libertador': ['tres cruces', 'parque batlle'],
  'av gianattasio': ['carrasco', 'carrasco norte'],
  'av instrucciones': ['prado', 'aires puros', 'sayago'],
  'colorado': ['goes', 'la comercial', 'la figurita'],
  'gestido': ['pocitos', 'punta carretas'],
  'fernandez crespo': ['goes', 'la blanqueada', 'reducto'],
  'cubo del norte': ['aguada', 'reducto'],
  'av san martin': ['goes', 'union'],
  'avenida san martin': ['goes', 'union'],
};

// ── Helper functions ──

function normalizeGeo(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Get candidate barrios from a Montevideo ZIP code.
 * Tries exact 5-digit match, then rounds to nearest hundred.
 */
export function getBarriosFromZip(zip: string | null | undefined): string[] | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, '');
  if (digits.length < 4) return null;

  // Exact match (e.g., "11500")
  if (MONTEVIDEO_ZIP_TO_BARRIOS[digits]) return MONTEVIDEO_ZIP_TO_BARRIOS[digits];

  // Round to nearest hundred (e.g., 11345 -> "11300")
  const rounded = digits.substring(0, 3) + '00';
  if (MONTEVIDEO_ZIP_TO_BARRIOS[rounded]) return MONTEVIDEO_ZIP_TO_BARRIOS[rounded];

  return null;
}

/**
 * Get department name from ZIP code prefix (first 2 digits).
 */
export function getDepartmentFromZip(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, '');
  if (digits.length < 2) return null;
  return DEPARTMENT_ZIP_PREFIX[digits.substring(0, 2)] ?? null;
}

/**
 * Get candidate barrios from a Montevideo street address.
 * Checks major avenue/street names in the address text.
 */
export function getBarriosFromStreet(address: string | null | undefined): string[] | null {
  if (!address) return null;
  const norm = normalizeGeo(address);
  if (norm.length < 3) return null;

  for (const [street, barrios] of Object.entries(MONTEVIDEO_STREET_TO_BARRIOS)) {
    if (norm.includes(street)) return barrios;
  }
  return null;
}
