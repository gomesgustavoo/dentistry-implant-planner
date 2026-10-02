const support = '<a href="mailto:support@dicomsegvr.com">support@dicomsegvr.com</a>';
const note = (extra: string) => `<p class="legal__note"><strong>Documento en lenguaje sencillo.</strong> Describe lo que el servicio hace realmente. No ha sido revisado por un abogado y no constituye asesoramiento jurídico.${extra}</p>`;

export const legal = {
  privacy: {
    title: 'Política de privacidad',
    description: 'Cómo trata ImplantPlan los estudios CBCT que usted sube, cuánto tiempo se conservan los resultados y quién trata sus datos.',
    html: `
<h1>Política de privacidad</h1>
<p class="legal__meta">Última actualización: 2 de octubre de 2026 · dentistry.dicomsegvr.com</p>
${note(' Si trata datos de pacientes sujetos al RGPD, a la LGPD o a la HIPAA, haga que su propio asesor lo revise y formalice el acuerdo adecuado antes de subir nada.')}

<h2>1. Qué tratamos</h2>
<p>Las <strong>imágenes que usted sube</strong> (una CBCT dental, como archivo ZIP de DICOM o como volumen NIfTI) y los <strong>datos de la cuenta</strong> que aporta su inicio de sesión, que son un identificador, una dirección de correo electrónico y un nombre de usuario. Los pagos los gestiona íntegramente Stripe; nosotros solo almacenamos una referencia de cliente, nunca los datos de la tarjeta.</p>

<h2>2. No desidentificamos las imágenes por usted</h2>
<p>Una serie DICOM contiene identificadores del paciente en sus cabeceras. Solo leemos la geometría que necesitamos y no indexamos, buscamos ni compartimos esas cabeceras, pero tampoco las eliminamos. No dé por hecho que un estudio que suba ha sido anonimizado. <strong>Desidentifíquelo antes de subirlo si sus obligaciones lo exigen.</strong></p>

<h2>3. Cuánto tiempo lo conservamos</h2>
<ul>
<li><strong>El archivo que usted sube se elimina en cuanto termina su trabajo.</strong> No se vuelve a leer nunca, así que no hay motivo para conservarlo.</li>
<li><strong>Los resultados caducan 72 horas después de completarse</strong> y se eliminan del disco. A partir de entonces, el punto de descarga responde <em>410 Gone</em>.</li>
<li>El registro del trabajo (tiempos, volúmenes de las estructuras y hallazgos de calidad, sin ninguna imagen) se conserva para que su recuento de uso y su historial sigan siendo exactos.</li>
<li>Los casos de ejemplo son datos de investigación públicos y no caducan.</li>
</ul>

<h2>4. Separación entre cuentas</h2>
<p>Cada caso se almacena bajo su propia cuenta, y cada solicitud se verifica frente a la cuenta propietaria. Una solicitud del caso de otra cuenta se responde como si el caso no existiera.</p>

<h2>5. Sin rastreadores</h2>
<p>No hay analítica ni píxeles publicitarios, y las fuentes se alojan en nuestros propios servidores. En la entrega de este sitio intervienen dos terceros: Cloudflare, que lo sirve y puede añadir un pequeño script que protege las direcciones de correo electrónico de los robots de spam, y YouTube, cuyo reproductor de vídeo se carga desde youtube-nocookie.com solo cuando usted pulsa reproducir (la imagen de vista previa anterior procede de i.ytimg.com). El inicio de sesión usa nuestro propio servicio de identidad; en un navegador, su token de sesión reside en la pestaña y se descarta al cerrarla.</p>

<h2>5a. Visores vinculados</h2>
<p>Si vincula un visor con ImplantPlan VR a su cuenta, el visor conserva un token de dispositivo propio. Solo almacenamos un hash de ese token, junto con la etiqueta del visor, quién lo vinculó, el espacio de trabajo al que pertenece y cuándo se vinculó y se usó por última vez. El token caduca 90 días después de la vinculación, o tras 30 días sin uso, lo que ocurra primero, y puede revocarlo en cualquier momento en Settings, Headsets. El código de vinculación que muestra el panel es válido durante 5 minutos y funciona una sola vez.</p>

<h2>6. Encargados del tratamiento</h2>
<ul>
<li><strong>Stripe</strong>: pagos y gestión de suscripciones.</li>
<li><strong>Cloudflare</strong>: terminación TLS y entrega de este sitio.</li>
</ul>
<p>La segmentación se ejecuta en nuestro propio hardware. Sus imágenes no se envían a ningún tercero ni se usan para entrenar nada.</p>

<h2>7. Sus derechos</h2>
<p>Puede solicitar una copia de lo que conservamos sobre usted, pedirnos que lo corrijamos o pedirnos que eliminemos su cuenta y todo lo que contiene. La eliminación borra en una sola operación los casos almacenados de la cuenta. Escriba a ${support}.</p>

<h2>8. Dónde se ejecuta</h2>
<p>El tratamiento y el almacenamiento se realizan en Brasil. Si transfiere datos personales desde otra jurisdicción, asegúrese de contar con una base jurídica para hacerlo.</p>

<h2>9. Cambios</h2>
<p>Los cambios sustanciales se anunciarán en esta página con una nueva fecha arriba. Seguir usando el servicio a partir de entonces implica su aceptación.</p>

<h2>10. Contacto</h2>
<p>${support}</p>`,
  },
  terms: {
    title: 'Condiciones del servicio',
    description: 'Las condiciones de uso de ImplantPlan, una versión preliminar de investigación para la segmentación de CBCT dental y la medición de la distancia de seguridad del implante.',
    html: `
<h1>Condiciones del servicio</h1>
<p class="legal__meta">Última actualización: 2 de octubre de 2026 · dentistry.dicomsegvr.com</p>
${note(' Haga que su propio asesor lo revise antes de basarse en él.')}

<h2>1. Qué es este servicio</h2>
<p>ImplantPlan segmenta automáticamente tomografías computarizadas de haz cónico (CBCT) dentales y devuelve las estructuras anatómicas como archivos RTSTRUCT, STL y NIfTI. También ofrece un visor web y herramientas de planificación de implantes que miden la distancia de seguridad entre un implante virtual y la anatomía segmentada. ImplantPlan VR, una aplicación para Meta Quest 3, Quest 3S y Quest Pro, abre los mismos casos en un visor una vez vinculado a su cuenta.</p>

<h2>2. Qué no es</h2>
<p>Es una <strong>versión preliminar de investigación</strong>. <strong>No es un producto sanitario</strong>, no cuenta con autorización regulatoria de ninguna autoridad y <strong>no es apto para uso diagnóstico</strong>. No genera guías quirúrgicas. Su resultado es un punto de partida para un profesional clínico cualificado, nunca un sustituto de este. Los valores de gris de la CBCT no son unidades Hounsfield calibradas, por lo que nada de lo que produce es una medición de densidad. Usted es responsable de revisar cada resultado antes de que informe cualquier decisión clínica.</p>

<h2>3. Exactitud</h2>
<p>Publicamos las mediciones que realmente podemos hacer y decimos con claridad cuáles no podemos; consulte <a href="/es/engineering/#limits">los límites de la investigación</a>. No garantizamos que una estructura esté correctamente identificada, correctamente numerada ni completa. Los hallazgos de calidad se informan y nunca se corrigen de forma silenciosa.</p>

<h2>4. Sus responsabilidades</h2>
<ul>
<li>Usted tiene derecho a subir las imágenes que sube, y cuenta con cualquier consentimiento que estas requieran.</li>
<li>Usted desidentifica las imágenes cuando sus obligaciones lo exigen.</li>
<li>Usted no intenta acceder a los datos de otra cuenta ni eludir los límites de uso.</li>
<li>Usted no comparte sus credenciales de inicio de sesión y revoca cualquier visor vinculado que ya no controle.</li>
</ul>

<h2>5. Planes y facturación</h2>
<p>La prueba le ofrece 30 segmentaciones en 14 días, lo que se agote primero, sin tarjeta de crédito. Los planes de pago son mensuales, se facturan por adelantado a través de Stripe e incluyen un número determinado de segmentaciones por mes natural; el plan Enterprise no tiene un límite fijo y está sujeto a un uso razonable, porque todos los trabajos comparten una GPU. El ajuste de un modelo con sus propios estudios se acuerda por separado antes de empezar. Las segmentaciones no utilizadas no se acumulan para el mes siguiente. Una segmentación es un estudio procesado por el pipeline completo; una nueva ejecución vuelve a contar, mientras que un trabajo fallido, o uno que usted cancele antes de que llegue a la GPU, no cuenta. Puede cancelar en cualquier momento desde la página de su cuenta, y el acceso se mantiene hasta el final del periodo pagado. Los meses parciales no se prorratean.</p>

<h2>6. Disponibilidad</h2>
<p>La segmentación se ejecuta en una sola GPU, por lo que los trabajos esperan en una cola. No ofrecemos ninguna garantía de disponibilidad y podemos interrumpir el servicio por mantenimiento. Los resultados caducan a las 72 horas, así que descargue lo que necesite.</p>

<h2>7. El modelo y lo que permite su licencia</h2>
<p>La segmentación usa un checkpoint de U-Mamba2 ajustado (fine-tuning) sobre el conjunto de datos ToothFairy3. Ese conjunto de datos se publica bajo <strong>CC BY-NC-SA 4.0</strong>, y un modelo entrenado con él hereda las mismas condiciones: atribución, compartir igual y <strong>uso exclusivamente no comercial</strong>. Este servicio es una versión preliminar de investigación y se ofrece en esas condiciones. Los autores originales figuran en los créditos de las <a href="/es/engineering/#credits">notas de ingeniería</a> y <strong>no respaldan este servicio</strong>.</p>

<h2>8. Responsabilidad</h2>
<p>En la máxima medida permitida por la ley, el servicio se presta tal cual, y nuestra responsabilidad total por cualquier reclamación se limita a las tarifas que usted haya pagado en los tres meses anteriores a que surgiera. No somos responsables de decisiones clínicas, pérdidas indirectas ni datos perdidos; conserve sus propias copias de todo lo que necesite.</p>

<h2>9. Suspensión</h2>
<p>Podemos suspender una cuenta que incumpla estas condiciones, que ponga en riesgo el servicio o a otros usuarios, o cuyo pago falle.</p>

<h2>10. Cambios y contacto</h2>
<p>Los cambios sustanciales se anunciarán en esta página con una nueva fecha arriba. Contacto: ${support}.</p>`,
  },
};
