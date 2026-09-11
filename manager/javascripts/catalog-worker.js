const {parentPort,workerData}=require('worker_threads');
try { parentPort.postMessage({result:require('./unitcatalog').scan(workerData)}); }
catch(e) { parentPort.postMessage({error:e.message}); }
