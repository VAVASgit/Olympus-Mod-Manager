const path=require('path');
const fs=require('fs');
const {Worker}=require('worker_threads');
const {scan}=require('./unitcatalog');
const {dialog,shell}=require('@electron/remote');
const ManagerPage=require('./managerpage');
const store=require('./catalog-store');
const {readJson}=require('./unitcatalog');
class CatalogUI {
    constructor(manager) {this.manager=manager;this.results=new Map();this.busy=false;this.source='mod';this.message='';this.error='';this.startupDone=false;this.prompts=[];this.visible=false;}
    instances() {return this.manager.getInstances().filter(x=>x.installed);}
    folder() {return this.selected || this.instances()[0]?.folder;}
    result() {return this.results.get(this.folder());}
    root(folder) {
        const configured=this.manager.options.catalogDcsRoots?.[folder];
        if(configured) return configured;
        const snap=readJson(path.join(folder,'Olympus','Catalog','dcs-catalog.json'),null);
        if(snap?.dcsRoot && fs.existsSync(path.join(snap.dcsRoot,'autoupdate.cfg'))) return snap.dcsRoot;
        return '';
    }
    async start() {
        if(this.startupDone) return; this.startupDone=true;this.busy=true;
        for(const instance of this.instances()) {
            try { const result=await this.scanFolder(instance.folder);this.results.set(instance.folder,result);
                const pending=result.inventory.filter(u=>u.source==='dcs'&&!u.conflict&&!u.ignored&&u.status!=='Up to date');
                if(pending.length) this.prompts.push({folder:instance.folder,ids:pending.map(u=>u.id),newCount:pending.filter(u=>u.status==='New unit').length});
            } catch(e) {this.error=e.message;}
        }
        this.busy=false;this.showNextPrompt();
    }
    scanFolder(folder) {
        return new Promise((resolve,reject)=>{
            const workerData={savedGames:folder,dcsRoot:this.root(folder)};
            let worker;
            try { worker=new Worker(path.join(__dirname,'catalog-worker.js'),{workerData}); }
            catch (workerError) {
                // Some packaged Electron builds expose worker_threads but do not
                // support constructing a Worker from the renderer. Keep scanning
                // compatible by yielding once, then use the same read-only parser.
                setTimeout(()=>{try { resolve(scan(workerData)); } catch(error) { reject(error); }},0);
                return;
            }
            const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Scan timed out. Check the DCS path and mod folders, then try again.'));},120000);
            worker.once('message',data=>{clearTimeout(timeout);data.error?reject(new Error(data.error)):resolve(data.result);});
            worker.once('error',e=>{clearTimeout(timeout);reject(e);});
            worker.once('exit',code=>{clearTimeout(timeout);if(code)reject(new Error('Catalog scan stopped unexpectedly.'));});
        });
    }
    showNextPrompt() {
        if(!this.prompts.length) return;
        this.prompt=this.prompts.shift();this.selected=this.prompt.folder;this.source='dcs';this.open();
    }
    open() {
        this.visible=true;
        if(!this.page) this.page=new ManagerPage(this.manager,'./ejs/catalog.ejs');
        if(this.manager.activePage!==this.page) {this.previous=this.manager.activePage;this.previous?.hide();}
        this.render();
    }
    render() {
        if(!this.page||!this.visible) return;
        const result=this.result();
        this.page.options={catalog:{instances:this.instances().map(i=>({folder:i.folder,name:i.name})),folder:this.folder(),root:this.folder()?this.root(this.folder()):'',result,source:this.source,busy:this.busy,message:this.message,error:this.error,prompt:this.prompt}};
        this.page.show(true);
    }
    async action(action,params) {
        if(this.busy) return;
        try {
            this.error='';
            if(action==='close') {this.prompt=null;this.visible=false;this.page.hide();this.previous?.show(true);this.showNextPrompt();return;}
            if(action==='source') {this.source=params;this.render();return;}
            if(action==='instance') {this.selected=params;this.prompt=null;this.message='';this.render();return;}
            if(action==='path') {
                const selected=await dialog.showOpenDialog({title:'Select your DCS World installation folder',properties:['openDirectory']});
                if(selected.canceled) return;
                const root=selected.filePaths[0];if(!fs.existsSync(path.join(root,'autoupdate.cfg'))) throw new Error('Choose the DCS World folder containing autoupdate.cfg.');
                this.manager.options.catalogDcsRoots ||= {};this.manager.options.catalogDcsRoots[this.folder()]=root;
                const options=await this.manager.getOptions();options.catalogDcsRoots=this.manager.options.catalogDcsRoots;
                store.atomic(path.join(__dirname,'..','options.json'),JSON.stringify(options,null,2));this.results.delete(this.folder());this.render();return;
            }
            if(action==='openMods') {await shell.openPath(path.join(this.folder(),'Mods'));return;}
            if(action==='openBackups') {const dir=path.join(this.folder(),'Olympus','Catalog','Backups');fs.mkdirSync(dir,{recursive:true});await shell.openPath(dir);return;}
            if(action==='later') {this.prompt=null;this.message='Deferred. Manager will ask again next time it opens.';this.render();this.showNextPrompt();return;}
            if(action==='no') {store.ignoreUnits(this.result(),this.prompt.ids);this.prompt=null;this.message='These versions were dismissed. Changed definitions will be offered again; manual import remains available.';this.render();this.showNextPrompt();return;}
            this.busy=true;this.message=action==='scan'?'Scanning installed units, payload presets and liveries…':'Saving a backup and applying your selection…';this.render();
            await new Promise(resolve=>setTimeout(resolve,30));
            if(action==='scan') {this.results.set(this.folder(),await this.scanFolder(this.folder()));this.message='Scan complete. Select the units you want to integrate.';}
            if(action==='import'||action==='yes') {
                const ids=action==='yes'?this.prompt.ids:params;
                if(!ids?.length) throw new Error('Select at least one unit to import.');
                const previous=this.result(), fresh=await this.scanFolder(this.folder());this.results.set(this.folder(),fresh);
                if(ids.some(id=>previous.inventory.find(u=>u.id===id)?.fingerprint!==fresh.inventory.find(u=>u.id===id)?.fingerprint))throw new Error('Unit definitions changed since the preview. Review the refreshed list before importing.');
                const r=store.importUnits(fresh,ids);this.prompt=null;
                this.results.set(this.folder(),await this.scanFolder(this.folder()));
                this.message=`Integrated ${r.count} units and ${r.payloadCount} presets. ${r.skipped.length} conflicts preserved. Restart the DCS mission and refresh the Olympus client to load the changes.`;
            }
            if(action==='restore') {
                const response=await dialog.showMessageBox({type:'question',buttons:['Cancel','Restore last import'],defaultId:0,cancelId:0,message:'Restore the files from before the last catalog import?',detail:'Later file edits are protected. Existing DCS mod files are never removed.'});
                if(response.response===1) {store.restoreLast(this.folder());this.results.set(this.folder(),await this.scanFolder(this.folder()));this.message='Last catalog import restored. Restart the mission and refresh the client.';} else this.message='Restore cancelled.';
            }
        } catch(e) {this.error=e.message;this.message='';}
        finally {this.busy=false;this.render();}
    }
}
module.exports=CatalogUI;
