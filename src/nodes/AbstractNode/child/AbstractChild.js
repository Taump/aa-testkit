const timekeeper = require('timekeeper')
const EventEmitter = require('events')
const Joi = require('joi')
const util = require('util')
const fs = require('fs')
const mkdirp = require('mkdirp')

const { isString } = require('lodash')
const {
	fromMessage,
	MessageLastMCI,
	MessageNewJoint,
	MessageUnitInfo,
	MessageBalanceOf,
	MessageUnitProps,
	MessageSavedUnit,
	MessageAAResponse,
	MessageCurrentTime,
	MessageAAStateVars,
	MessageTimeRunDone,
	MessageChildStarted,
	MessageTimeFreezeDone,
	MessageTimeTravelDone,
	MessageMciBecameStable,
	MessageOutputsBalanceOf,
	MessageExecuteGetterDone,
} = require('../../../messages')

class AbstractChild extends EventEmitter {
	constructor (params, paramsSchema, options) {
		super()
		this.setMaxListeners(20)
		this.isTimeFrozen = false
		this.writeStream = null
		this.isShuttingDown = false

		const { error, value } = Joi.validate(
			params,
			(paramsSchema instanceof Function) ? paramsSchema() : paramsSchema,
			options,
		)
		if (error) throw new Error(`[${this.constructor.name}][${params.id}] ${error}`)
		Object.assign(this, value)

		mkdirp.sync(process.env.HOME)
		const conf = require('ocore/conf.js')
		conf.deviceName = this.id

		process
			.on('message', this.handleParentMessage.bind(this))
			.setMaxListeners(20)

		this
			.on('command_child_stop', () => this.stop())
			.on('command_get_time', (m) => this.getTime(m))
			.on('command_time_run', (m) => this.timerun(m))
			.on('command_time_freeze', (m) => this.timefreeze(m))
			.on('command_time_travel', (m) => this.timetravel(m))
			.on('command_get_last_mci', (m) => this.getLastMCI(m))
			.on('command_get_unit_info', (m) => this.getUnitInfo(m))
			.on('command_get_unit_props', (m) => this.getUnitProps(m))
			.on('command_get_balance_of', (m) => this.getBalanceOf(m))
			.on('command_execute_getter', (m) => this.executeGetter(m))
			.on('command_read_aa_state_vars', (m) => this.readAAStateVars(m))
			.on('command_get_outputs_balance_of', (m) => this.getOutputsBalanceOf(m))

		const eventBus = require('ocore/event_bus')
		eventBus
			.on('mci_became_stable', (mci) => this.sendToParent(new MessageMciBecameStable({ mci })))
			.on('aa_response', (objAAResponse) => this.sendToParent(new MessageAAResponse({ response: objAAResponse })))
			.on('new_joint', (joint) => this.sendToParent(new MessageNewJoint({ joint })))
			.on('saved_unit', (joint) => this.sendToParent(new MessageSavedUnit({ joint })))

		process.on('SIGINT', () => {
			this.shutdown()
		})
		process.on('SIGTERM', () => {
			this.shutdown()
		})
	}

	static unpackArgv (argv) {
		throw new Error('Abstarct `unpackArgv` implementation used')
	}

	start () {
		this.replaceConsoleLog()
		this.sendToParent(new MessageChildStarted())
	}

	stop () {
		console.log('Received command to stop')
		this.shutdown()
	}

	shutdown () {
		if (!this.isShuttingDown) {
			this.isShuttingDown = true
			const network = require('ocore/network')
			network.closeAllWsConnections()
			console.log('process shutdown')
			const stream = this.writeStream
			this.writeStream = null
			stream.end('', () => {
				process.exit()
			})
		}
	}

	timefreeze () {
		if (this.isTimeFrozen) {
			this.sendToParent(new MessageTimeFreezeDone({ error: 'Time has been frozen already' }))
		} else {
			this.isTimeFrozen = true
			timekeeper.freeze(Date.now())
			this.sendToParent(new MessageTimeFreezeDone({ error: null }))
		}
	}

	timerun () {
		if (this.isTimeFrozen) {
			this.isTimeFrozen = false
			const currentDate = Date.now()
			timekeeper.reset()
			timekeeper.travel(new Date(currentDate))

			this.sendToParent(new MessageTimeRunDone({ error: null }))
		} else {
			this.sendToParent(new MessageTimeRunDone({ error: 'Time is running already' }))
		}
	}

	timetravel ({ to, shift }) {
		const currentDate = Date.now()

		try {
			const newDate = to
				? new Date(to)
				: currentDate + this.shiftToMs(shift)

			if (newDate < currentDate) {
				throw new Error('Attempt to timetravel in past')
			}
			timekeeper.travel(new Date(newDate))
			this.sendToParent(new MessageTimeTravelDone({ error: null, timestamp: Date.now() }))
		} catch (error) {
			this.sendToParent(new MessageTimeTravelDone({ error: error.message, timestamp: null }))
		}
	}

	shiftToMs (shift) {
		if (Number.isInteger(shift)) {
			return shift
		} else if (isString(shift)) {
			const match = shift.match(/^(\d+)([smhd])$/)
			if (match) {
				const number = Number(match[1])
				const duration = match[2]
				switch (duration) {
				case 's':
					return number * 1000
				case 'm':
					return number * 1000 * 60
				case 'h':
					return number * 1000 * 60 * 60
				case 'd':
					return number * 1000 * 60 * 60 * 24
				}
			} else {
				throw new Error(`Unsupported 'shift' format '${shift}'`)
			}
		}
		return 0
	}

	getTime () {
		this.sendToParent(new MessageCurrentTime({ time: Date.now() }))
	}

	getUnitInfo ({ unit }) {
		const db = require('ocore/db')
		const { readJoint } = require('ocore/storage')
		readJoint(db, unit, {
			ifNotFound: () => {
				this.sendToParent(new MessageUnitInfo({ unitObj: null, error: 'Unit not found' }))
			},
			ifFound: (objJoint) => {
				this.sendToParent(new MessageUnitInfo({ unitObj: objJoint.unit, error: null }))
			},
		})
	}

	getUnitProps ({ unit }) {
		const db = require('ocore/db')

		db.query(
			// eslint-disable-next-line no-multi-str
			'SELECT unit, level, latest_included_mc_index, main_chain_index, is_on_main_chain, is_free, is_stable, witnessed_level, headers_commission, payload_commission, sequence, timestamp, GROUP_CONCAT(address) AS author_addresses, COALESCE(witness_list_unit, unit) AS witness_list_unit\n\
				FROM units \n\
				JOIN unit_authors USING(unit) \n\
				WHERE unit=? \n\
				GROUP BY +unit',
			[unit],
			(rows) => {
				if (rows.length !== 1) {
					this.sendToParent(new MessageUnitProps({ unitProps: {} }))
				} else {
					const props = rows[0]
					props.author_addresses = props.author_addresses.split(',')
					this.sendToParent(new MessageUnitProps({ unitProps: props }))
				}
			},
		)
	}

	getLastMCI () {
		const storage = require('ocore/storage')
		storage.readLastMainChainIndex((mci) => {
			this.sendToParent(new MessageLastMCI({ mci }))
		})
	}

	sendToParent (message) {
		console.log('sendToParent', JSON.stringify(message.serialize(), null, 2))
		process.send(message.serialize())
	}

	handleParentMessage (m) {
		console.log('handleParentMessage', JSON.stringify(m, null, 2))
		const message = fromMessage(m)
		this.emit(message.topic, message)
	}

	async readAAStateVars ({ address }) {
		const isProcessingAaTriggers = () => {
			return new Promise((resolve) => {
				const db = require('ocore/db')
				db.query('SELECT mci FROM aa_triggers', [], async (rows) => {
					resolve(!!rows.length)
				})
			})
		}

		const waitFinishProcessingAaTriggers = async () => {
			const isProcessing = await isProcessingAaTriggers()

			if (isProcessing) {
				await new Promise(resolve => {
					const eventBus = require('ocore/event_bus')
					eventBus.once(`aa_response_from_aa-${address}`, resolve)
				})
				await waitFinishProcessingAaTriggers()
			}
		}

		await waitFinishProcessingAaTriggers()
		const vars = await this.getAAStateVarsFromStorage(address)
		this.sendToParent(new MessageAAStateVars({ vars }))
	}

	getAAStateVarsFromStorage (address) {
		return new Promise(resolve => {
			const storage = require('ocore/storage')
			storage.readAAStateVars(address, (vars) => {
				resolve(vars)
			})
		})
	}

	getBalanceOf ({ address }) {
		const wallet = require('ocore/wallet')
		wallet.readBalance(address, (assocBalances) => {
			this.sendToParent(new MessageBalanceOf({ balance: assocBalances }))
		})
	}

	getOutputsBalanceOf ({ address }) {
		const balances = require('ocore/balances')
		balances.readOutputsBalance(address, (assocBalances) => {
			this.sendToParent(new MessageOutputsBalanceOf({ balance: assocBalances }))
		})
	}

	async executeGetter ({ aaAddress, getter, args }) {
		const db = require('ocore/db')
		const { executeGetter } = require('ocore/formula/evaluation')
		try {
			const result = await executeGetter(db, aaAddress, getter, args)
			this.sendToParent(new MessageExecuteGetterDone({ result, error: null }))
		} catch (error) {
			this.sendToParent(new MessageExecuteGetterDone({ result: null, error: error.message || error }))
		}
	}

	replaceConsoleLog () {
		const desktopApp = require('ocore/desktop_app.js')
		const conf = require('ocore/conf.js')
		const appDataDir = desktopApp.getAppDataDir()
		mkdirp.sync(appDataDir)

		const logFilename = conf.LOG_FILENAME || (appDataDir + '/log.txt')
		this.writeStream = fs.createWriteStream(logFilename, { flags: 'a' })
		console.log = (...args) => {
			if (this.writeStream) {
				this.writeStream.write(this.logPrefix())
				this.writeStream.write(util.format.apply(null, args) + '\n')
			}
		}
		console.error = console.log
		console.warn = console.log
		console.info = console.log
	}

	logPrefix () {
		return Date().toString() + ': '
	}
}

module.exports = AbstractChild
