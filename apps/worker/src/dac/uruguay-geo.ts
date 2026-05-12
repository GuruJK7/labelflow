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
  'sur': 'Artigas',

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
  'atlantida norte': 'Canelones',
  'atlantida canelones': 'Canelones',
  'shangrila': 'Canelones',
  'shangri-la': 'Canelones',
  'canada chica': 'Canelones',
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
  // 2026-05-12 audit — Kimberly Lezue (parqueada) had city="18 De Mayo",
  // province=Montevideo on Shopify. "18 de Mayo" is actually a small town
  // in Canelones (departamento). Without this entry the geo DB returned
  // null, so the existing GEO CORRECTION couldn't fire, the order shipped
  // as Montevideo, and DAC silently rejected because the city isn't in
  // the MVD dropdown.
  //
  // Only this one entry — adding speculative city names without
  // verification risks misrouting other orders. Add more on a per-incident
  // basis with a comment + production order reference.
  '18 de mayo': 'Canelones',

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
  'las violetas': 'Durazno',

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
  'barrio elisa': 'Maldonado',

  // ─────────────────────────────────────────────
  // MONTEVIDEO (capital: Montevideo)
  // ─────────────────────────────────────────────
  'montevideo': 'Montevideo',
  // Common Montevideo abbreviations seen in real Shopify orders (e.g.
  // city="Mvdo.", "Mdeo", "MVD"). The lookup key is the post-normalized
  // form (lowercased, dot stripped, accents removed) — see
  // getDepartmentForCity() above. Without these, the deterministic
  // resolver returns undefined and the order falls through to the AI
  // resolver (or, if ANTHROPIC_API_KEY is unset, to DacAddressRejectedError).
  // Catching abbreviations here is zero-cost and covers the common case.
  'mvdo': 'Montevideo',
  'mdeo': 'Montevideo',
  'mvd': 'Montevideo',
  'mdo': 'Montevideo',
  'mtdeo': 'Montevideo',
  'mtvdeo': 'Montevideo',
  'mvdeo': 'Montevideo',
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
  'bella vista': 'Montevideo',
  'larranaga': 'Montevideo',
  'flor de maronas': 'Montevideo',
  'ituzaingo': 'Montevideo',
  'punta carreta': 'Montevideo',
  'parque carrasco': 'Montevideo',
  'carrasco norte': 'Montevideo',
  'carrasco sur': 'Montevideo',
  'la figurita': 'Montevideo',
  'barrio sur': 'Montevideo',
  'las canteras': 'Montevideo',
  'tres ombues': 'Montevideo',
  'villa munoz': 'Montevideo',
  'aires puros': 'Montevideo',
  'cerrito': 'Montevideo',
  'mercado modelo': 'Montevideo',
  'pocitos nuevo': 'Montevideo',
  'punta de rieles': 'Montevideo',
  'paso de las duranas': 'Montevideo',

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
  'gautron': 'Salto',
  'sato': 'Salto',

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
  'picada de las tunas': 'San Jose',
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
  'jardines del hum': 'Soriano',

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
 * Map of each Uruguay department to its capital city — the city the
 * customer's package will be routed to when DAC's city dropdown for the
 * department doesn't have an option matching the customer-typed city.
 *
 * Audit 2026-05-06 — motivation: order #11748 (naza fernandez) had
 * Shopify city = "San José" with province = "San José". DAC's San José
 * dept dropdown has options like "San José de Mayo", "Libertad", "Ciudad
 * del Plata" — but NOT "San José" alone. The form silently rejected.
 * Same pattern affects Cerro Largo (capital is "Melo"), Soriano ("Mercedes"),
 * Río Negro ("Fray Bentos"), Lavalleja ("Minas"), Flores ("Trinidad"),
 * Colonia ("Colonia del Sacramento").
 *
 * Used by `correctCityWhenEqualsDepartment()` below. Only the dept names
 * whose capital differs from the dept name get corrected — for the rest
 * (Maldonado, Florida, Rocha, Salto, etc.) "city == dept name" is a
 * legitimate match (the capital IS named after the dept).
 */
export const DEPARTMENT_CAPITALS: Record<string, string> = {
  'Artigas': 'Artigas',
  'Canelones': 'Canelones',
  'Cerro Largo': 'Melo',
  'Colonia': 'Colonia del Sacramento',
  'Durazno': 'Durazno',
  'Flores': 'Trinidad',
  'Florida': 'Florida',
  'Lavalleja': 'Minas',
  'Maldonado': 'Maldonado',
  'Montevideo': 'Montevideo',
  'Paysandu': 'Paysandu',
  'Rio Negro': 'Fray Bentos',
  'Rivera': 'Rivera',
  'Rocha': 'Rocha',
  'Salto': 'Salto',
  'San Jose': 'San Jose de Mayo',
  'Soriano': 'Mercedes',
  'Tacuarembo': 'Tacuarembo',
  'Treinta y Tres': 'Treinta y Tres',
};

/**
 * Returns the capital city for a department, or null if the department
 * isn't recognized. Accepts accent variants ("San José" → "San Jose").
 */
export function getCapitalCity(department: string | null | undefined): string | null {
  if (!department) return null;
  const normalized = department
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [dept, capital] of Object.entries(DEPARTMENT_CAPITALS)) {
    if (
      dept.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === normalized
    ) {
      return capital;
    }
  }
  return null;
}

/**
 * If the customer-typed `city` is the SAME string as the resolved
 * department name (e.g. "San José" + dept "San José"), substitute it
 * with the department capital so DAC's city dropdown has a chance of
 * matching. No-op when city == capital already (e.g. dept Maldonado +
 * city Maldonado is fine — DAC's Maldonado dropdown HAS Maldonado).
 *
 * Returns the corrected city (or the original if no correction was
 * needed). Empty/null inputs return as-is.
 *
 * Audit 2026-05-06 — see #11748 naza fernandez for the production case
 * that drove this. Customer typed `city: "San José"` and DAC silently
 * rejected because no city option matched.
 */
export function correctCityWhenEqualsDepartment(
  city: string | null | undefined,
  department: string | null | undefined,
): string | null | undefined {
  if (!city || !department) return city;
  const cityNorm = city.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const deptNorm = department.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  if (cityNorm !== deptNorm) return city; // Different — no correction needed
  const capital = getCapitalCity(department);
  if (!capital) return city; // Unknown department — leave as-is
  // If capital equals the department name (e.g. Maldonado/Maldonado),
  // the original city is fine.
  const capitalNorm = capital.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  if (capitalNorm === deptNorm) return city;
  return capital;
}

/**
 * Handle the customer-typed pattern "City-Department" (e.g.
 * "Dolores-Soriano", "Cardona-Soriano") — common when the Shopify
 * checkout doesn't have a separate dept selector and the customer
 * concatenates both into the city field.
 *
 * Returns just the city part if:
 *   - the input contains exactly one hyphen
 *   - the first part is a recognized city in CITY_TO_DEPARTMENT
 *
 * Otherwise returns the input unchanged.
 *
 * Audit 2026-05-06 — production case #11733 Silvia Aranda
 * (city="Dolores-Soriano"). The deterministic resolver returned
 * undefined for the full string, the fuzzy matcher couldn't reach it
 * (length difference > 1), so the order fell into the AI fallback. AI
 * sometimes recovers but not always. This makes the resolution
 * deterministic.
 *
 * Safety: we only substitute when the first part is in our geo dict.
 * Random pre-hyphen text ("foo-bar") returns unchanged.
 */
export function splitHyphenatedCityName(
  city: string | null | undefined,
): string {
  if (!city) return '';
  if (!city.includes('-')) return city;
  const parts = city.split('-').map((p) => p.trim()).filter(Boolean);
  // Require exactly two parts — three-hyphen forms ("a-b-c") are weird
  // and we'd rather pass through unchanged than guess wrong.
  if (parts.length !== 2) return city;
  const firstNormalized = parts[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (CITY_TO_DEPARTMENT[firstNormalized] !== undefined) {
    return parts[0]; // preserve customer's original casing
  }
  return city;
}

/**
 * Compute the Levenshtein edit distance between two strings (number of
 * single-character insertions, deletions, or substitutions to turn `a`
 * into `b`). Used by `fuzzyMatchCity` for typo correction. Internal
 * helper exported only for tests.
 *
 * Standard DP implementation. O(|a|·|b|) time, O(min(|a|,|b|)) space.
 * For our use case (city names ≤ 30 chars vs ~600 candidates) this is
 * trivially fast.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Always iterate over the shorter string in the inner loop
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  const m = s.length;
  const n = t.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,        // insertion
        prev[i] + 1,            // deletion
        prev[i - 1] + cost,     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/**
 * Returns the canonical city key from CITY_TO_DEPARTMENT that most
 * closely matches `typedCity` within an edit-distance threshold. Used
 * to recover from common typos before the address resolver runs:
 *
 *   "parque batalle"   → "parque batlle"   (dist 1)
 *   "monteideo"        → "montevideo"      (dist 1)
 *   "tacuarmebó"       → "tacuarembo"      (dist 2)
 *   "fray bento"       → "fray bentos"     (dist 1)
 *
 * Safety constraints (audit 2026-05-06 — false positives here re-route
 * packages to the wrong department, so this is conservative):
 *
 *   - Input must be ≥ 5 normalized characters. Shorter strings are too
 *     easy to falsely match ("Sur" → "Sus"? no thanks).
 *   - Distance threshold defaults to 1. Pass `maxDistance=2` when you
 *     want slightly more tolerance (and accept slightly more risk).
 *   - All candidates within the threshold MUST resolve to the SAME
 *     department. If two equally-close candidates resolve to different
 *     departments (e.g. "Centro" ambiguity), we return null — let the
 *     AI resolver or operator decide.
 *   - If `typedCity` is already an EXACT match in CITY_TO_DEPARTMENT,
 *     this function returns that match (with distance 0).
 *
 * Returns null when no safe match exists. Returns the canonical key
 * (lowercase, accent-stripped) when one is found — the caller can look
 * up the department via CITY_TO_DEPARTMENT[result].
 *
 * Audit 2026-05-06: motivation is order #11705 (Valeria Ramírez) where
 * Shopify city = "Parque batalle" caused the deterministic resolver to
 * fall through to the AI fallback, which returned an inconsistent dept
 * and DAC silently rejected. A pre-resolver typo-fix would have
 * normalized this to "parque batlle" → unambiguously Montevideo.
 */
export function fuzzyMatchCity(
  typedCity: string | null | undefined,
  maxDistance: number = 1,
): string | null {
  if (!typedCity) return null;
  const normalized = typedCity
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < 5) return null; // too short to safely fuzzy-match

  // Exact match short-circuit (free, common case)
  if (CITY_TO_DEPARTMENT[normalized] !== undefined) {
    return normalized;
  }

  // Find the minimum distance and the candidates achieving it
  let bestDist = Infinity;
  let bestCandidates: string[] = [];
  for (const key of Object.keys(CITY_TO_DEPARTMENT)) {
    // Quick length-prune: if the lengths differ by more than maxDistance,
    // there's no way the edit distance can be ≤ maxDistance.
    if (Math.abs(key.length - normalized.length) > maxDistance) continue;
    const d = levenshtein(normalized, key);
    if (d > maxDistance) continue;
    if (d < bestDist) {
      bestDist = d;
      bestCandidates = [key];
    } else if (d === bestDist) {
      bestCandidates.push(key);
    }
  }

  if (bestCandidates.length === 0) return null;

  // Multiple candidates at the same min distance — only safe if they
  // all resolve to the same department.
  if (bestCandidates.length > 1) {
    const depts = new Set(bestCandidates.map((k) => CITY_TO_DEPARTMENT[k]));
    if (depts.size > 1) return null; // ambiguous
    // Same dept — pick the alphabetically-first key for deterministic output
    bestCandidates.sort();
  }

  return bestCandidates[0];
}

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
  let normalized = cityName
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, ' ')      // "La.paz" → "La paz"
    .replace(/\s+/g, ' ')      // collapse multiple spaces
    .trim();

  // Direct match
  if (CITY_TO_DEPARTMENT[normalized]) return CITY_TO_DEPARTMENT[normalized];

  // Strip country suffix: "montevideo- URUGUAY" → "montevideo"
  normalized = normalized.replace(/[-,]\s*uruguay$/i, '').trim();
  if (CITY_TO_DEPARTMENT[normalized]) return CITY_TO_DEPARTMENT[normalized];

  // Handle pipe separator: "2|montevideo" → try parts after pipe
  if (normalized.includes('|')) {
    const parts = normalized.split('|').map(p => p.trim());
    for (const part of parts) {
      if (CITY_TO_DEPARTMENT[part]) return CITY_TO_DEPARTMENT[part];
    }
  }

  // Handle slash separator: "centro/Rivera" → try each part
  if (normalized.includes('/')) {
    const parts = normalized.split('/').map(p => p.trim());
    for (const part of parts) {
      if (CITY_TO_DEPARTMENT[part]) return CITY_TO_DEPARTMENT[part];
    }
  }

  // Handle comma separator: "Barrio Espanol, Atlantida Norte" → try after comma, then before
  if (normalized.includes(',')) {
    const parts = normalized.split(',').map(p => p.trim());
    // Try each part (after comma often more specific)
    for (const part of [...parts].reverse()) {
      if (CITY_TO_DEPARTMENT[part]) return CITY_TO_DEPARTMENT[part];
    }
  }

  // Handle compound city: "Ciudad de la Costa solymar" → try progressive substrings
  const words = normalized.split(' ');
  if (words.length > 2) {
    // Try removing last word progressively
    for (let len = words.length - 1; len >= 2; len--) {
      const sub = words.slice(0, len).join(' ');
      if (CITY_TO_DEPARTMENT[sub]) return CITY_TO_DEPARTMENT[sub];
    }
    // Try last N words
    for (let start = 1; start < words.length - 1; start++) {
      const sub = words.slice(start).join(' ');
      if (CITY_TO_DEPARTMENT[sub]) return CITY_TO_DEPARTMENT[sub];
    }
  }

  // Handle "carrasco sur jardines de carrasco" → try first two words
  if (words.length >= 2) {
    const twoWords = words.slice(0, 2).join(' ');
    if (CITY_TO_DEPARTMENT[twoWords]) return CITY_TO_DEPARTMENT[twoWords];
  }

  // Single word fallback (first word)
  if (words.length > 1 && CITY_TO_DEPARTMENT[words[0]]) {
    return CITY_TO_DEPARTMENT[words[0]];
  }

  return undefined;
}

/**
 * Async version: tries local DB first, then falls back to Nominatim geocoding.
 * Use this in the main processing pipeline. The sync version above is for tests.
 *
 * When Nominatim resolves a city, it gets added to the in-memory map
 * so subsequent orders with the same city are instant.
 */
export async function getDepartmentForCityAsync(cityName: string): Promise<string | undefined> {
  // Fast path: local DB
  const local = getDepartmentForCity(cityName);
  if (local) return local;

  // Slow path: geocoding fallback
  try {
    const { geocodeCityToDepartment } = await import('./geocode-fallback');
    const dept = await geocodeCityToDepartment(cityName);
    if (dept) {
      // Learn: add to in-memory map so we never geocode this city again in this run
      const normalized = cityName.trim().toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
      CITY_TO_DEPARTMENT[normalized] = dept;
      return dept;
    }
  } catch {
    // Geocoding is best-effort — never crash the pipeline
  }

  return undefined;
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
  '12500': ['capurro', 'belvedere', 'aguada'],
  '12600': ['pocitos nuevo', 'villa española'],
  '12700': ['tres ombues', 'villa muñoz'],
  '12800': ['cerrito'],
};

/**
 * Maps first 2 digits of Uruguayan ZIP code to department name.
 *
 * Audit 2026-05-05 — REWRITTEN. Previous map was systematically wrong:
 * almost every prefix from 25 onward pointed to the wrong department,
 * causing Tacuarembó orders (real ZIP 45000) to resolve as "Río Negro",
 * Río Negro orders (65000) as "Flores", etc. The original errors were
 * masked because the city-name lookup almost always wins over the ZIP
 * fallback — but the moment a customer typed an ambiguous city like
 * "Centro" or left the city blank, the wrong ZIP mapping took over and
 * the deterministic resolver propagated the wrong department to DAC.
 *
 * The new map is verified against ~5,400 real production orders from
 * the last 180 days (see `scripts/zip-prefix-audit.sql`). Each prefix
 * here is the dominant city pattern observed in RunLog meta:
 *
 *   11/12/13: Montevideo  (633+79+5 orders, all Montevideo barrios)
 *   15/16:    Canelones   (Costa de Oro: El Pinar, Lagomar, La Floresta)
 *   20:       Maldonado   (Maldonado, Punta del Este, San Carlos)
 *   27:       Rocha       (Rocha, Chuy, La Paloma — 3,982 orders!)
 *   30:       Lavalleja   (Minas, José Pedro Varela)
 *   33:       Treinta y Tres
 *   37:       Cerro Largo (Melo, Río Branco)
 *   40:       Rivera
 *   45:       Tacuarembó  (Tacuarembó, Paso de los Toros) ← was "Rio Negro"
 *   50:       Salto
 *   55:       Artigas
 *   60:       Paysandú
 *   65:       Río Negro   (Fray Bentos, Young) ← was "Flores"
 *   70:       Colonia     (Colonia, Carmelo, Nueva Palmira)
 *   75:       Soriano     (Mercedes — 400 orders)
 *   80:       San José    (San José de Mayo, Ciudad del Plata)
 *   85:       Flores      (Trinidad) ← was "Tacuarembo"
 *   90/91:    Canelones   (Canelones capital, Las Piedras, Pando, Sauce)
 *   94:       Florida     (Florida, Sarandí Grande)
 *
 * Prefixes 17, 21, 25, 35, 47, 97, 98 were intentionally removed:
 *   - 17, 25, 35, 47: never observed in production
 *   - 21: only 2 cases, both Maldonado — handled by city name
 *   - 97, 98: ambiguous in real data (Rivera vs Durazno, Florida vs
 *     Durazno) — letting the city-name resolver handle these is safer
 *     than picking a wrong default.
 */
export const DEPARTMENT_ZIP_PREFIX: Record<string, string> = {
  '11': 'Montevideo',
  '12': 'Montevideo',
  '13': 'Montevideo',
  '15': 'Canelones',
  '16': 'Canelones',
  '20': 'Maldonado',
  '27': 'Rocha',
  '30': 'Lavalleja',
  '33': 'Treinta y Tres',
  '37': 'Cerro Largo',
  '40': 'Rivera',
  '45': 'Tacuarembo',
  '50': 'Salto',
  '55': 'Artigas',
  '60': 'Paysandu',
  '65': 'Rio Negro',
  '70': 'Colonia',
  '75': 'Soriano',
  '80': 'San Jose',
  '85': 'Flores',
  '90': 'Canelones',
  '91': 'Canelones',
  '94': 'Florida',
};

/**
 * Set of ALL 19 valid Uruguay department names, normalized
 * (lowercase, accent-stripped). Used by shipment.ts to validate that
 * a Shopify-supplied `province` is a real Uruguay department before
 * trusting it over the city's geo lookup.
 */
export const URUGUAY_DEPARTMENTS_NORMALIZED: Set<string> = new Set(
  DEPARTMENTS.map(d =>
    d.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  ).concat([
    // Accent variants the customer or Shopify may emit:
    'paysandu', 'paysandú',
    'rio negro', 'río negro',
    'san jose', 'san josé',
    'tacuarembo', 'tacuarembó',
  ])
);

/**
 * Names that, when used as a Shopify "city" field, are ambiguous and
 * must NOT alone be trusted to override the customer's stated province.
 *
 * Every Uruguayan town has a "Centro" (downtown) — the customer who
 * types `city: "Centro"` is naming THEIR town's center, not a barrio of
 * Montevideo. Same for "Cerro" (also a department: Cerro Largo) and
 * "Bella Vista" (a town in Maldonado AND a barrio in Montevideo).
 *
 * The pre-fix behavior: getDepartmentForCity("Centro") returned
 * "Montevideo" (because "centro" is in CITY_TO_DEPARTMENT as a MVD
 * barrio), and shipment.ts then OVERRODE the customer's correct
 * Shopify province with "Montevideo". Confirmed misroutes from the
 * 2026-05-05 audit:
 *   - #11616 Adriana Martinez — Tacuarembó/"Centro" → Montevideo
 *   - #11015 — Rocha/"Centro" → Montevideo
 *   - #11129 — Treinta y Tres/"Centro" → Montevideo
 *   - #11673 Flavia Falero — Maldonado/"Centro/San Carlos" → Montevideo
 *   - #1215  Ines Velazco — Maldonado/"Bella Vista" → Montevideo
 *
 * Names here are normalized (lowercased, accent-stripped). The match
 * is on the WHOLE city string after normalize() — partial matches are
 * not flagged (e.g. "Centro Tacuarembó" is a multi-word string and
 * gets handled by getDepartmentForCity's fuzzy fallbacks).
 */
export const AMBIGUOUS_CITY_NAMES: Set<string> = new Set([
  // Generic descriptors — every town has these
  'centro',
  'cerro',
  'bella vista',
  'bellavista',
  'union',
  'la union',
  'manga',
  'prado',
  'colon',
  'la paz', // also a town in Canelones AND Colonia
  // Ambiguous compounds — the slash form a customer types when they
  // mean "Centro de [their town]"
  'centro/montevideo',
  'centro/canelones',
  'centro/maldonado',
  'centro/san carlos',
  'centro/rivera',
  'centro/salto',
  'centro/tacuarembo',
  'centro/durazno',
  'centro/florida',
  'centro/colonia',
]);

/**
 * Returns true if `city` is a generic name that should not, by itself,
 * be trusted to override a customer's stated province. See
 * AMBIGUOUS_CITY_NAMES for the rationale and the audit-confirmed
 * misroutes that motivated this list.
 */
export function isAmbiguousCityName(city: string | null | undefined): boolean {
  if (!city) return false;
  const normalized = city
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return AMBIGUOUS_CITY_NAMES.has(normalized);
}

/**
 * Returns true if `province` is a recognizable Uruguay department name
 * (covers accent variants and common Shopify spellings). Used to decide
 * whether a Shopify `province` field is trustworthy enough to override
 * an ambiguous geo lookup.
 */
export function isValidUruguayProvince(province: string | null | undefined): boolean {
  if (!province) return false;
  const normalized = province
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return URUGUAY_DEPARTMENTS_NORMALIZED.has(normalized);
}

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
  'rbla': ['ciudad vieja', 'centro', 'palermo', 'parque rodo', 'pocitos', 'punta carretas', 'buceo', 'malvin', 'punta gorda', 'carrasco'],
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
  'av libertador': ['parque batlle', 'tres cruces'],
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
