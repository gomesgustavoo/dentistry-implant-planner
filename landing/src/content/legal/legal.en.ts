const support = '<a href="mailto:support@dicomsegvr.com">support@dicomsegvr.com</a>';
const note = (extra: string) => `<p class="legal__note"><strong>Plain-language document.</strong> It describes what the service actually does. It has not been reviewed by a lawyer and is not legal advice.${extra}</p>`;

export const legal = {
  privacy: {
    title: 'Privacy Policy',
    description: 'How ImplantPlan handles the CBCT scans you upload, how long results are kept, and who processes your data.',
    html: `
<h1>Privacy Policy</h1>
<p class="legal__meta">Last updated 29 September 2026 · dentistry.dicomsegvr.com</p>
${note(' If you process patient data under the GDPR, the LGPD, or HIPAA, have your own adviser review it and put an appropriate agreement in place before you upload anything.')}

<h2>1. What we process</h2>
<p>Two things: the <strong>imaging you upload</strong> (a dental CBCT, as a DICOM ZIP file or a NIfTI volume) and the <strong>account details</strong> your sign-in provides, which are an identifier, an email address, and a username. Payments are handled entirely by Stripe; we store only a customer reference, never card details.</p>

<h2>2. Imaging is not de-identified for you</h2>
<p>A DICOM series carries patient identifiers in its headers. We read only the geometry we need, and we do not index, search, or share those headers, but we do not remove them either. Do not assume that a scan you upload has been anonymized. <strong>De-identify it before uploading if your obligations require it.</strong></p>

<h2>3. How long we keep it</h2>
<ul>
<li><strong>Your upload is deleted as soon as its job completes.</strong> It is never read again, so there is no reason to keep it.</li>
<li><strong>Results expire 72 hours after completion</strong> and are removed from disk. After that, the download endpoint answers <em>410 Gone</em>.</li>
<li>The job record (timings, structure volumes, and quality findings, with no imaging) is kept so that your usage count and history stay accurate.</li>
<li>The example cases are public research data and do not expire.</li>
</ul>

<h2>4. Separation between accounts</h2>
<p>Every case is stored under its own account, and every request is checked against the account that owns it. A request for another account’s case is answered as if the case did not exist.</p>

<h2>5. No trackers</h2>
<p>There are no analytics and no advertising pixels, and the fonts are self-hosted. Two third parties are involved in delivering this site: Cloudflare, which serves it and may add a small script that protects email addresses from spam bots, and YouTube, whose video player loads from youtube-nocookie.com only when you press play (the preview image before that comes from i.ytimg.com). Sign-in uses our own identity service; your session token lives in your browser tab and is discarded when you close it.</p>

<h2>6. Processors we use</h2>
<ul>
<li><strong>Stripe</strong>: payments and subscription management.</li>
<li><strong>Cloudflare</strong>: TLS termination and delivery of this site.</li>
</ul>
<p>Segmentation runs on our own hardware. Your imaging is not sent to any third party and is not used to train anything.</p>

<h2>7. Your rights</h2>
<p>You may ask for a copy of what we hold about you, ask us to correct it, or ask us to delete your account and everything under it. Deletion removes the account’s stored cases in one operation. Write to ${support}.</p>

<h2>8. Where it runs</h2>
<p>Processing and storage take place in Brazil. If you transfer personal data from another jurisdiction, make sure you have a lawful basis for doing so.</p>

<h2>9. Changes</h2>
<p>Material changes will be announced on this page with a new date above. Continuing to use the service after that constitutes acceptance.</p>

<h2>10. Contact</h2>
<p>${support}</p>`,
  },
  terms: {
    title: 'Terms of Service',
    description: 'The terms for using ImplantPlan, a research preview for dental CBCT segmentation and implant clearance measurement.',
    html: `
<h1>Terms of Service</h1>
<p class="legal__meta">Last updated 29 September 2026 · dentistry.dicomsegvr.com</p>
${note(' Have your own adviser review it before you rely on it.')}

<h2>1. What this service is</h2>
<p>ImplantPlan segments dental cone-beam CT automatically and returns the anatomical structures as RTSTRUCT, STL, and NIfTI files. It also provides a browser viewer and implant-planning tools that measure the clearance between a virtual implant and the segmented anatomy.</p>

<h2>2. What it is not</h2>
<p>It is a <strong>research preview</strong>. It is <strong>not a medical device</strong>, it has no regulatory clearance from any authority, and it is <strong>not for diagnostic use</strong>. It does not produce surgical guides. Its output is a starting point for a qualified clinician, never a substitute for one. CBCT gray values are not calibrated Hounsfield units, so nothing it produces is a density measurement. You are responsible for reviewing every result before it informs any clinical decision.</p>

<h2>3. Accuracy</h2>
<p>We publish the measurements we can actually make and state plainly the ones we cannot; see <a href="/engineering/#limits">the limits of the research</a>. We make no warranty that a structure is correctly identified, correctly numbered, or complete. Quality findings are reported and never silently corrected.</p>

<h2>4. Your responsibilities</h2>
<ul>
<li>You have the right to upload the imaging you upload, and any consent it requires.</li>
<li>You de-identify imaging where your obligations require it.</li>
<li>You do not attempt to reach another account’s data or to work around usage limits.</li>
<li>You keep your sign-in credentials to yourself.</li>
</ul>

<h2>5. Plans and billing</h2>
<p>A trial gives you 30 segmentations over 14 days, whichever runs out first, with no credit card required. Paid plans are monthly, billed in advance through Stripe, and include a stated number of segmentations per calendar month. Unused segmentations do not roll over. One segmentation is one scan through the full pipeline; a re-run counts again, while a failed job, or one you cancel before it reaches the GPU, does not count. You can cancel at any time from your account page, and access continues to the end of the paid period. Partial months are not prorated.</p>

<h2>6. Availability</h2>
<p>Segmentation runs on a single GPU, so jobs wait in a queue. We offer no uptime guarantee and may take the service down for maintenance. Results expire after 72 hours, so download what you need.</p>

<h2>7. The model, and what its license permits</h2>
<p>Segmentation uses a U-Mamba2 checkpoint fine-tuned on the ToothFairy3 dataset. That dataset is released under <strong>CC BY-NC-SA 4.0</strong>, and a model trained on it inherits the same terms: attribution, share-alike, and <strong>non-commercial use only</strong>. This service is a research preview and is offered on those terms. The upstream authors are credited in the <a href="/engineering/#credits">engineering notes</a> and <strong>do not endorse this service</strong>.</p>

<h2>8. Liability</h2>
<p>To the fullest extent the law allows, the service is provided as is, and our total liability for any claim is limited to the fees you paid in the three months before it arose. We are not liable for clinical decisions, indirect losses, or lost data; keep your own copies of anything you need.</p>

<h2>9. Suspension</h2>
<p>We may suspend an account that breaches these terms, that puts the service or other users at risk, or whose payment fails.</p>

<h2>10. Changes and contact</h2>
<p>Material changes will be announced on this page with a new date above. Contact: ${support}.</p>`,
  },
};
