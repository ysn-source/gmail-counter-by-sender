
const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(process.cwd(), 'res/token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'res/credentials.json');
const CSV_PATH = path.join(process.cwd(),"out/out.csv");
require('events').EventEmitter.defaultMaxListeners = 2000;
process.setMaxListeners(0);
async function loadSavedCredentialsIfExist() {
  try {
    const credentials = JSON.parse(await fs.readFile(TOKEN_PATH));
    return google.auth.fromJSON(credentials);
  } catch (err) { return null; }
}
async function saveCredentials(client) {
  const keys = JSON.parse(await fs.readFile(CREDENTIALS_PATH));
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({type: 'authorized_user',
                                    client_id: key.client_id,
                                    client_secret: key.client_secret,
                                    refresh_token: client.credentials.refresh_token});
  await fs.writeFile(TOKEN_PATH, payload);
}
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) { return client; }
  console.log(`Credentials File : ${CREDENTIALS_PATH}`);
  client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH});
  if (client.credentials) { await saveCredentials(client); }
  return client;
}

var api = {
    init : (auth) => api.gmail = google.gmail({version: 'v1', auth}),
    gmail : null,
    replyTime: 0,
    findLabel: async function (LabelPattern) {
        return new Promise ((res,err)=>{
          api.gmail.users.labels.list({userId: 'me',}).then(response=>{
            if (!response.data.labels || response.data.labels.length === 0) {err(0)}
            response.data.labels.forEach((label) => {
              if (label.name.toLowerCase()==LabelPattern) {
                api.gmail.users.labels.get({userId: 'me',id:label.id}).then(la=>{//console.log(la.data);
                  res({"id":label.id,"total":la.data.threadsTotal,"unread":la.data.threadsUnread});
                });
              }
            });
          })
        });        
    },
    listThreads : async function (labelId,page=0)  {
      let json = {
        userId: 'me',
        maxResults: 500,
        labelIds:[labelId]
      };
      if (page !=0) {
        json = {...json,   pageToken: page}
      }
      
      let res = await api.gmail.users.threads.list(json);
      //console.log(res);
      return res;
    },
    getThread : async function (id)  {
        delayer(api.replyTime);
        let res = await api.gmail.users.threads.get({
            userId: 'me',
            id : id
        });
        
        if (res.status!=200) { api.replyTime=500; }
        else { api.replyTime=10;}
        return res.data;
    },
    readThread : async function (tid) {
      return new Promise (async (res,rej)=>{ 
        let data = await api.getThread(tid);//.catch(err=>{         console.log(err);         api.replyTime=500;        });
        let msgs = data.messages;
        let from = msgs[0].payload.headers.find(i=>i.name=="From").value;
        let size = msgs.reduce((a,s)=>a+s.sizeEstimate,0);
    
        res({"from" : from.substring(from.indexOf("<")+1,from.length-1),
            "name" : from.substring(0,from.indexOf("<")-1),
            "cnt":msgs.length,
            "size":size});
      });
    }
}
function delayer(millis)
{
    var date = new Date(), curDate = null;
    do { curDate = new Date(); } while(curDate-date < millis);
}
function eta(lastDate,msg) {
  let d = new Date();
  console.log(`${msg} : ${(d-lastDate)/1000}sec`);
  return d;
}
function sumAccumulator (glob,arr) {
	return arr.reduce((acc,t)=>{
		if (acc.some(i=>i.from==t.from)) { 
      let oldIdx = acc.findIndex(i=>i.from==t.from);
		  acc[oldIdx] = {"from":acc[oldIdx].from,
        "name":acc[oldIdx].name,
        "cnt":t.cnt+acc[oldIdx].cnt,
        "size":t.size+acc[oldIdx].size};
		} else { 
			acc=[...acc,{"from":t.from,
        "name":t.from,
        "cnt":t.cnt,
        "size":t.size}];
		}
    return acc;
	},glob);
}
function fileformat(date) {
  return `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2,"0")}${date.getDate().toString().padStart(2,"0")}${date.getHours().toString().padStart(2,"0")}${date.getMinutes().toString().padStart(2,"0")}`
}
async function explore (label) {
	var out = [];
	let starttime= new Date();
  let v= await api.findLabel(label.toLowerCase());
  console.log(starttime.toTimeString().substring(0,starttime.toTimeString().indexOf("(")-1));
  console.log(`Recherche dans le label "${label}" / ${v.total} threads dont ${v.unread} non lus`);
  
  let next=0,threadList = [];
  while (next!=undefined) {
		let current= await api.listThreads(v.id,next);
    threadList = threadList.concat(current.data.threads.flatMap(i=>i.id));
    next = current.data.nextPageToken;
  }
  let readtime,listtime = eta(starttime,`Elapsed time to list Threads`);

  let flat = [],i=0;
  for (let t of threadList) {
    if (i%1000==0) {
      await Promise.all(flat);
      readtime = eta(listtime,`Elapsed time for ${i} thread reads ~${Math.round(100*i/v.total*100)/100}%`);
      
    }  
    i++;
   flat.push(api.readThread(t));
  }
  flat = await Promise.all(flat);
  let flattime = eta(readtime,`Elapsed time to get message info`);
  
  out = sumAccumulator(out,flat);   
	let reducetime = eta(flattime,`Elapsed time to aggregate`);
   


	out = out.sort((a,b)=>a.cnt - b.cnt);
  let sorttime = eta(reducetime,`Elapsed time to sort`);
  fs.writeFile(CSV_PATH.replace("out.csv",`${fileformat(sorttime)}_out.csv`),
  `FROM;NAME;COUNTER;SIZE\n${out.map(i=>`${i.from};${i.name};${i.cnt};${i.size}`).split(`\n`)}`);
  eta(starttime,`Total time`);
}



authorize().then(api.init).then(async t=> await explore("INBOX"));