'use client';
import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './ui/alert-dialog';

interface ImageState { image: string | null; revision: number; telegram: boolean }
const endpoint=(id:string)=>'/v1/admin/setup/assistants/'+encodeURIComponent(id)+'/image';
const notify=(id:string)=>window.dispatchEvent(new CustomEvent('assistant-image-changed',{detail:id}));

export function AssistantAvatar({id}:{id:string}) {
  const [image,setImage]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;
    const load=()=>{void api<ImageState>(endpoint(id)).then(value=>{if(active)setImage(value.image);}).catch(()=>{});};
    const changed=(event:Event)=>{if((event as CustomEvent).detail===id)load();};
    load();window.addEventListener('assistant-image-changed',changed);
    return()=>{active=false;window.removeEventListener('assistant-image-changed',changed);};
  },[id]);
  return image || id==='zero' ? <img src={image || '/icon.png'} alt="" className="assistant-photo"/> : <Bot size={20}/>;
}

async function thumbnail(source:string) {
  const image=new Image(); image.src=source; await image.decode();
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const context=canvas.getContext('2d');if(!context)throw new Error('No se pudo preparar la imagen.');
  context.fillStyle='#0f172a';context.fillRect(0,0,256,256);
  const size=Math.min(image.naturalWidth,image.naturalHeight);
  context.drawImage(image,(image.naturalWidth-size)/2,(image.naturalHeight-size)/2,size,size,0,0,256,256);
  return canvas.toDataURL('image/jpeg',0.85);
}

export function AssistantImageSettings({id,name}:{id:string;name:string}) {
  const {busy,notice,setNotice,run}=useAdminTask();
  const [value,setValue]=useState<ImageState>(),[preview,setPreview]=useState<string|null>(null),[dirty,setDirty]=useState(false);
  async function load(){const next=await api<ImageState>(endpoint(id));setValue(next);setPreview(next.image);setDirty(false);}
  useEffect(()=>{void run(load);},[id]);
  async function save(image:string|null){
    if(!value)return;
    const saved=await api<ImageState>(endpoint(id),'PUT',{image,revision:value.revision});
    setValue({...saved,telegram:value.telegram});setPreview(saved.image);setDirty(false);notify(id);setNotice('Imagen guardada en Zero. Telegram no se ha modificado.');
  }
  return <section className="settings-section assistant-image-settings">
    <h3>Imagen del asistente</h3>
    <div className="assistant-image-preview">{preview ? <img src={preview} alt={'Imagen de '+name}/> : <AssistantAvatar id={id}/>}</div>
    <Label htmlFor={'assistant-image-'+id}>Subir imagen</Label>
    <Input id={'assistant-image-'+id} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || !value}
      onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void run(async()=>{
        if(file.size>5_000_000 || !['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Usa PNG, JPEG o WebP de hasta 5 MB.');
        const url=URL.createObjectURL(file);try{setPreview(await thumbnail(url));setDirty(true);}finally{URL.revokeObjectURL(url);}
      });}}/>
    <p>Se recorta al centro. Guardar aquí cambia el avatar en Zero; publicar en Telegram es una acción separada.</p>
    {notice && <p role="status">{notice}</p>}
    <div className="form-actions">
      <Button type="button" disabled={busy || !value || !dirty} onClick={()=>void run(()=>save(preview))}>Guardar imagen en Zero</Button>
      <Button type="button" variant="outline" disabled={busy || !value} onClick={()=>void run(()=>save(null))}>Quitar imagen de Zero</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={()=>void run(load)}>Recargar imagen</Button>
    </div>
    {value?.telegram ? <div className="form-actions">
      <Button type="button" variant="outline" disabled={busy} onClick={()=>void run(async()=>{
        const remote=await api<{image:string|null}>(endpoint(id)+'/telegram');
        if(!remote.image){setNotice('El bot no tiene foto de perfil.');return;}
        setPreview(await thumbnail(remote.image));setDirty(true);setNotice('Foto de Telegram importada como vista previa. Guarda para usarla en Zero.');
      })}>Importar foto actual de Telegram</Button>
      <AlertDialog>
        <AlertDialogTrigger asChild><Button type="button" variant="outline" disabled={busy || dirty || !value.image}>Actualizar foto de Telegram</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>¿Actualizar la foto de {name} en Telegram?</AlertDialogTitle><AlertDialogDescription>Esto modifica la foto pública del bot conectado. Se publica la imagen guardada en Zero.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction type="button" onClick={()=>void run(async()=>{
            await api(endpoint(id)+'/telegram','POST',{image:value.image,confirm:true});setNotice('Telegram ha confirmado la nueva foto del bot.');
          })}>Publicar foto</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div> : <p>Este asistente no tiene una conexión de Telegram configurada.</p>}
  </section>;
}
